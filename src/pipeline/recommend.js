// The recommendation pipeline: brief -> long list -> enrich with real data -> digest real reviews -> final slate.
import { ask } from '../llm.js';
import { searchGoodreads, fetchGoodreadsBook } from '../sources/goodreads.js';
import { searchOpenLibrary } from '../sources/openlibrary.js';
import { searchLubimyczytac, fetchLubimyczytacBook } from '../sources/lubimyczytac.js';
import { searchHardcover } from '../sources/hardcover.js';
import { getSession, updateSession, getSetting, upsertBook, getBook, getBookByGoodreadsId, findBookByTitle, setReviewDigest, addRecommendation, hydrateBook, db } from '../db.js';
import { BRIEF_SCHEMA, BRIEF_SYSTEM, CANDIDATES_SCHEMA, CANDIDATES_SYSTEM, DIGEST_SCHEMA, DIGEST_SYSTEM, RANK_SCHEMA, RANK_SYSTEM } from '../prompts.js';
import { fullContext, excludeList } from './context.js';

const running = new Map(); // sessionId -> { listeners:Set, log:[] }

export function progressOf(sessionId) {
  return running.get(sessionId) || null;
}
export function subscribe(sessionId, fn) {
  const r = running.get(sessionId);
  if (!r) return () => {};
  r.listeners.add(fn);
  return () => r.listeners.delete(fn);
}

function logger(sessionId) {
  const r = { listeners: new Set(), log: [] };
  running.set(sessionId, r);
  return (step, msg, extra = {}) => {
    const ev = { t: new Date().toISOString(), step, msg, ...extra };
    r.log.push(ev);
    updateSession(sessionId, { progress: r.log });
    for (const fn of r.listeners) { try { fn(ev); } catch {} }
  };
}

export async function runRecommendation(sessionId) {
  if (running.has(sessionId)) throw new Error('already running');
  const log = logger(sessionId);
  updateSession(sessionId, { status: 'researching' });
  try {
    const ctx = fullContext(sessionId);
    // 1. Brief
    log('brief', 'Reading your answers and building the brief...');
    const brief = (await ask({
      system: BRIEF_SYSTEM, schema: BRIEF_SCHEMA, tier: getSetting('tier_brief', 'smart'), effort: 'high',
      prompt: `READER CONTEXT (JSON):\n${JSON.stringify(ctx, null, 1)}\n\nWrite the recommendation brief.`,
    })).data;
    updateSession(sessionId, { brief, summary: brief.reader_now });
    log('brief', 'Brief ready', { brief });

    // 2. Long list
    const excludes = excludeList();
    log('candidates', 'Thinking about candidates (this is the slow, smart step)...');
    const web = getSetting('candidates_web', 'true') === 'true';
    const longlist = (await ask({
      system: CANDIDATES_SYSTEM, schema: CANDIDATES_SCHEMA, tier: getSetting('tier_candidates', 'best'), effort: 'high', web, maxTurns: 18,
      prompt: `BRIEF (JSON):\n${JSON.stringify(brief, null, 1)}\n\nREADER DNA:\n${ctx.reader_dna || '(none yet)'}\n\nDO NOT RECOMMEND (already read, shelved, recommended or rejected):\n${excludes.join('\n') || '(nothing yet)'}\n\nPropose the long list.`,
    })).data.candidates;
    log('candidates', `${longlist.length} candidates proposed`, { candidates: longlist.map((c) => `${c.title} - ${c.author}`) });

    // 3. Enrich with real data (Goodreads page per book, cached)
    log('enrich', 'Fetching real descriptions, ratings and reviews...');
    const enriched = await mapLimit(longlist, 4, async (c) => {
      try {
        const book = await enrichCandidate(c, { polish: (brief.constraints?.languages || []).some((l) => /^pl|polish|polski/i.test(l)) });
        if (book) log('enrich', `Found: ${book.title} (${book.ratings_count?.toLocaleString() || '?'} ratings, ${book.reviews?.length || 0} reviews)`);
        else log('enrich', `Could not verify: ${c.title} - ${c.author}`);
        return book ? { candidate: c, book } : null;
      } catch (e) { log('enrich', `Failed: ${c.title}: ${e.message}`); return null; }
    });
    const found = enriched.filter(Boolean);
    if (found.length < 3) throw new Error('Too few candidates could be verified against Goodreads. Check your connection and retry.');

    // 4. Review digests (cached per book forever)
    const todo = found.filter((x) => !x.book.review_digest);
    log('digest', `Reading real reviews for ${todo.length} books (${found.length - todo.length} cached)...`);
    await mapLimit(todo, 4, async (x) => {
      try { x.book.review_digest = await digestBook(x.book); log('digest', `Digested: ${x.book.title}`); }
      catch (e) { log('digest', `Digest failed: ${x.book.title}: ${e.message}`); }
    });

    // 5. Rank
    log('rank', 'Choosing the final slate...');
    const packed = found.map((x, i) => ({
      index: i, title: x.book.title, author: x.book.author, year: x.book.year, pages: x.book.pages, language: x.book.language,
      genres: x.book.genres.slice(0, 8), rating: x.book.rating, ratings_count: x.book.ratings_count, rating_dist_1to5: x.book.rating_dist,
      series: x.book.extra?.series?.filter((s) => s.title) || [], awards: x.book.extra?.awards?.slice(0, 3) || [],
      description: (x.book.description || '').slice(0, 900), proposed_slot: x.candidate.slot, proposed_why: x.candidate.why,
      polish_edition: x.book.extra?.lubimyczytac || null, hardcover_tags: x.book.extra?.hardcover || null,
      review_digest: x.book.review_digest || null,
    }));
    const ranked = (await ask({
      system: RANK_SYSTEM, schema: RANK_SCHEMA, tier: getSetting('tier_rank', 'best'), effort: 'high',
      prompt: `BRIEF (JSON):\n${JSON.stringify(brief, null, 1)}\n\nREADER DNA:\n${ctx.reader_dna || '(none yet)'}\n\nTODAY'S ANSWERS:\n${JSON.stringify(ctx.session_answers, null, 1)}\n\nENRICHED CANDIDATES (JSON, index = candidate_index):\n${JSON.stringify(packed, null, 1)}\n\nChoose the slate.`,
    })).data;

    db.prepare('DELETE FROM recommendations WHERE session_id = ?').run(sessionId);
    let rank = 1;
    for (const p of ranked.picks) {
      const x = found[p.candidate_index]; if (!x) continue;
      addRecommendation({ sessionId, bookId: x.book.id, rank: rank++, slot: p.slot, fit: { ...p, kind: 'pick' } });
    }
    for (const r of ranked.runners_up || []) {
      const x = found[r.candidate_index]; if (!x) continue;
      addRecommendation({ sessionId, bookId: x.book.id, rank: rank++, slot: 'runner_up', fit: { kind: 'runner_up', one_line: r.one_line } });
    }
    updateSession(sessionId, { status: 'recommended', ended_at: new Date().toISOString(), brief: { ...brief, note_to_reader: ranked.note_to_reader, dropped: (ranked.dropped || []).map((d) => ({ title: found[d.candidate_index]?.book?.title, reason: d.reason })) } });
    log('done', 'Done');
  } catch (e) {
    log('error', e.message);
    updateSession(sessionId, { status: 'interview' });
    throw e;
  } finally {
    setTimeout(() => running.delete(sessionId), 60_000);
  }
}

// ---------- enrichment ----------
function norm(s = '') { return s.toLowerCase().replace(/\(.*?\)/g, '').split(':')[0].replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function lastName(a = '') { const parts = a.trim().split(/\s+/); return (parts[parts.length - 1] || '').toLowerCase(); }
function titleMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) return 0.85;
  const xs = new Set(x.split(' ')), ys = new Set(y.split(' '));
  const inter = [...xs].filter((w) => ys.has(w)).length;
  return inter / Math.max(xs.size, ys.size);
}

export async function enrichCandidate(c, { polish = false } = {}) {
  const cached = findBookByTitle(c.title, c.author);
  if (cached && cached.goodreads_id && cached.reviews?.length) {
    if (polish && !cached.extra?.lubimyczytac) await attachPolish(cached, c).catch(() => {});
    return cached;
  }
  let results = [];
  try { results = await searchGoodreads(c.search_query || `${c.title} ${c.author}`, { limit: 8 }); } catch { results = []; }
  if (!results.length) { try { results = await searchGoodreads(c.title, { limit: 8 }); } catch { results = []; } }
  if (!results.length) {
    // Goodreads search blocked or empty: resolve an ISBN via Open Library and open the Goodreads page by ISBN.
    try {
      const ol = (await searchOpenLibrary(`${c.title} ${c.author}`, { limit: 3 })).find((d) => d.isbn && titleMatch(d.title, c.title) > 0.6);
      if (ol) {
        const r = await fetch(`https://www.goodreads.com/book/isbn/${ol.isbn}`, { headers: { 'User-Agent': 'book-finder-personal/0.1' }, redirect: 'follow' });
        const gid = r.url.match(/\/book\/show\/(\d+)/)?.[1];
        if (gid) results = [{ goodreadsId: gid, title: c.title, author: c.author, ratingsCount: 0 }];
      }
    } catch {}
  }
  const ln = lastName(c.author);
  let best = null; let bestScore = 0;
  for (const r of results) {
    const t = titleMatch(r.title, c.title);
    const a = r.author && ln && r.author.toLowerCase().includes(ln) ? 1 : 0;
    const score = t * 0.7 + a * 0.3 + Math.min((r.ratingsCount || 0) / 200000, 0.1);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!best || bestScore < 0.55) return null;
  const existing = getBookByGoodreadsId(best.goodreadsId);
  if (existing && existing.reviews?.length) return existing;
  await sleep(300 + Math.random() * 400);
  const full = await fetchGoodreadsBook(best.goodreadsId);
  // Open Library: subjects + reading counts as a second opinion (best effort)
  try {
    const ol = (await searchOpenLibrary(`${full.title} ${full.author || ''}`, { limit: 1 }))[0];
    if (ol && titleMatch(ol.title, full.title) > 0.7) { full.olKey = ol.olKey; full.subjects = ol.subjects; full.olStats = { rating: ol.rating, ratingsCount: ol.ratingsCount, wantToRead: ol.wantToRead, alreadyRead: ol.alreadyRead }; }
  } catch {}
  // Hardcover (optional token): independent crowd moods/tags and rating distribution
  const hcToken = getSetting('hardcover_token', '');
  if (hcToken) {
    try {
      const hc = (await searchHardcover(`${full.title} ${full.author || ''}`, hcToken, { limit: 3 })).find((x) => titleMatch(x.title, full.title) > 0.7);
      if (hc) full.hardcover = { rating: hc.rating, ratingsCount: hc.ratingsCount, moods: hc.moods, genres: hc.genres, tags: hc.tags, contentWarnings: hc.contentWarnings };
    } catch {}
  }
  const id = upsertBook(full);
  const book = getBook(id);
  if (polish) await attachPolish(book, c).catch(() => {});
  return book;
}

// Polish edition: rating on a 1-10 scale plus real Polish reviews, merged into the review set for the digest.
async function attachPolish(book, c) {
  let hits = [];
  try { hits = await searchLubimyczytac(`${c.title} ${c.author}`); } catch {}
  if (!hits.length) { try { hits = await searchLubimyczytac(c.author); } catch {} }
  const ln = lastName(c.author);
  const hit = hits.find((x) => x.author.toLowerCase().includes(ln) && titleMatch(x.title, c.title) > 0.5) || hits.find((x) => x.author.toLowerCase().includes(ln) && hits.length <= 3);
  if (!hit) return;
  await sleep(300);
  const lc = await fetchLubimyczytacBook(hit.url);
  if (lc.originalTitle && titleMatch(lc.originalTitle, c.title) < 0.5 && titleMatch(lc.title, c.title) < 0.5) return;
  const extra = { ...(book.extra || {}), lubimyczytac: { url: lc.url, polishTitle: lc.title, rating10: lc.rating10, ratingsCount: lc.ratingsCount, pages: lc.pages } };
  const reviews = [...(book.reviews || []), ...lc.reviews.slice(0, 12)];
  db.prepare('UPDATE books SET extra = ?, reviews = ? WHERE id = ?').run(JSON.stringify(extra), JSON.stringify(reviews), book.id);
  book.extra = extra; book.reviews = reviews;
}

export async function digestBook(book) {
  const reviews = (book.reviews || []).slice(0, 42).map((r, i) => `#${i + 1} [${r.rating ?? '?'}/5${r.rating10 ? ' (' + r.rating10 + '/10 PL)' : ''}, ${r.likes} likes${r.createdAt ? ', ' + r.createdAt : ''}${r.source === 'lubimyczytac' ? ', Polish reader on lubimyczytac.pl' : ''}]${r.shelves?.length ? ' shelves: ' + r.shelves.join(', ') : ''}\n${r.text.slice(0, 1400)}`).join('\n\n');
  const hc = book.extra?.hardcover ? `\nHardcover.app crowd tags: moods ${JSON.stringify(book.extra.hardcover.moods)}, genres ${JSON.stringify(book.extra.hardcover.genres)}, content warnings ${JSON.stringify(book.extra.hardcover.contentWarnings)}.` : '';
  const pl = book.extra?.lubimyczytac ? `\nPolish edition "${book.extra.lubimyczytac.polishTitle}": ${book.extra.lubimyczytac.rating10}/10 from ${book.extra.lubimyczytac.ratingsCount} Polish readers.` : '';
  const prompt = `BOOK: ${book.title} by ${book.author} (${book.year || '?'}), ${book.pages || '?'} pages. Genres: ${book.genres.join(', ')}.
Average ${book.rating} from ${book.ratings_count?.toLocaleString()} ratings. Distribution 1..5 stars: ${JSON.stringify(book.rating_dist)}.${hc}${pl}

DESCRIPTION:
${(book.description || '').slice(0, 2500)}

REAL READER REVIEWS (${(book.reviews || []).length}):
${reviews || '(none available)'}

Write the digest.`;
  const { data } = await ask({ system: DIGEST_SYSTEM, prompt, schema: DIGEST_SCHEMA, tier: getSetting('tier_digest', 'fast'), effort: 'low' });
  setReviewDigest(book.id, data);
  return data;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Manual add: look up a book by free text, fetch it and return it (for shelves and history).
export async function lookupBook(q) {
  const results = await searchGoodreads(q, { limit: 6 });
  return results;
}
export async function importGoodreadsBook(goodreadsId) {
  const existing = getBookByGoodreadsId(goodreadsId);
  if (existing && existing.reviews?.length) return existing;
  const full = await fetchGoodreadsBook(goodreadsId);
  return getBook(upsertBook(full));
}
