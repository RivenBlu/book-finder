// The recommendation pipeline: brief -> long list -> enrich with real data -> digest real reviews -> final slate.
// Three shapes: a slate for tonight (full/quick), a READING PATH (books in order over weeks), and a GIFT for someone else.
import { ask } from '../llm.js';
import { searchGoodreads, fetchGoodreadsBook } from '../sources/goodreads.js';
import { searchOpenLibrary } from '../sources/openlibrary.js';
import { searchLubimyczytac, fetchLubimyczytacBook } from '../sources/lubimyczytac.js';
import { searchHardcover } from '../sources/hardcover.js';
import { getSession, updateSession, getSetting, upsertBook, getBook, getBookByGoodreadsId, findBookByTitle, setReviewDigest, addRecommendation, getRecommendations, setRecommendationFeedback, latestVerdict, addAnswer, digestStale, knownBooks, now as dbNow, db } from '../db.js';
import { BRIEF_SCHEMA, BRIEF_SYSTEM, CANDIDATES_SCHEMA, CANDIDATES_SYSTEM, DIGEST_SCHEMA, DIGEST_SYSTEM, RANK_SCHEMA, RANK_SYSTEM, PATH_BRIEF_SCHEMA, PATH_BRIEF_SYSTEM, PATH_RANK_SCHEMA, PATH_RANK_SYSTEM } from '../prompts.js';
import { fullContext, excludeList, answersDigest } from './context.js';
import { verdictFor } from './talk.js';

const running = new Map(); // sessionId -> { listeners:Set, log:[] }
// Books the reader asked to keep while watching the research ("keep it in"): they reach the final list whatever the ranking says.
const keepers = new Map(); // sessionId -> Set(bookId)
export function keepBook(sessionId, bookId, on = true) {
  const set = keepers.get(sessionId) || new Set(); keepers.set(sessionId, set);
  if (on) set.add(bookId); else set.delete(bookId);
  return [...set];
}
export function keptBooks(sessionId) { return [...(keepers.get(sessionId) || [])]; }
// What the progress page shows for a candidate the moment it is found: enough to recognise the book and decide to keep it.
function card(book) {
  const d = book.review_digest;
  const line = d?.one_line || (book.description || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s/).slice(0, 2).join(' ').slice(0, 220);
  return { id: book.id, title: book.title, author: book.author, cover: book.cover, pages: book.pages, year: book.year, rating: book.rating, line };
}
const RESCUE_SCHEMA = { ...CANDIDATES_SCHEMA, properties: { candidates: { ...CANDIDATES_SCHEMA.properties.candidates, minItems: 3, maxItems: 10 } } };
const MAX_PICKS = 8;
// A re-run or an adjustment keeps the earlier slate as evidence: its rows are marked superseded, in one transaction
// with the new rows, and only once the new slate is ready. A book is written once per slate.
function saveSlate(sessionId, write) {
  const used = new Set();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE recommendations SET superseded_at = ? WHERE session_id = ? AND superseded_at IS NULL').run(dbNow(), sessionId);
    write((args) => { if (used.has(args.bookId)) return null; used.add(args.bookId); return addRecommendation(args); }, used);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// A failed run stays readable for a few seconds (so the progress page can show the error) but never blocks a retry.
export function progressOf(sessionId) {
  return running.get(sessionId) || null;
}
export function isRunning(sessionId) {
  const r = running.get(sessionId);
  return !!r && !r.failed;
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
  if (isRunning(sessionId)) throw new Error('already running');
  const log = logger(sessionId);
  const session = getSession(sessionId);
  if (!session) { running.delete(sessionId); throw new Error('no such session'); }
  const mode = session.mode;
  const statusBefore = session.status;
  const briefBefore = session.brief, summaryBefore = session.summary;
  let failed = false;
  updateSession(sessionId, { status: 'researching' });
  try {
    const gift = mode === 'gift';
    const path = mode === 'path';
    const ctx = gift ? { today: new Date().toISOString().slice(0, 10), gift: true, note: 'This slate is a GIFT for the person described in session_answers. The profile owner is not the reader.', session_answers: answersDigest(sessionId) } : fullContext(sessionId);

    // 1. Brief
    log('brief', path ? 'Reading your answers and designing the arc...' : 'Reading your answers and building the brief...');
    const brief = (await ask({
      system: path ? PATH_BRIEF_SYSTEM : BRIEF_SYSTEM, schema: path ? PATH_BRIEF_SCHEMA : BRIEF_SCHEMA, tier: getSetting('tier_brief', 'smart'), effort: 'high',
      prompt: `READER CONTEXT (JSON):\n${JSON.stringify(ctx, null, 1)}\n\n${path ? 'Design the reading path brief.' : gift ? 'Write the recommendation brief for the gift recipient.' : 'Write the recommendation brief.'}`,
    })).data;
    if (path) brief.slots = brief.stages.map((s) => `${s.id}: ${s.job}; ${s.from_state} -> ${s.to_state}; ${s.appeal_targets.pace}, ${s.appeal_targets.tone.join('/')}; up to ${s.max_pages} pages`);
    updateSession(sessionId, { brief, summary: brief.reader_now });
    log('brief', 'Brief ready', { brief });

    // 2. Long list
    const excludes = gift ? [] : excludeList();
    log('candidates', 'Thinking about candidates (this is the slow, smart step)...');
    const web = getSetting('candidates_web', 'true') === 'true';
    const longlist = (await ask({
      system: CANDIDATES_SYSTEM, schema: CANDIDATES_SCHEMA, tier: getSetting('tier_candidates', 'best'), effort: 'high', web, maxTurns: 18,
      prompt: `BRIEF (JSON):\n${JSON.stringify(brief, null, 1)}\n\nREADER DNA:\n${gift ? '(gift: not applicable)' : ctx.reader_dna || '(none yet)'}\n\nDO NOT RECOMMEND (already read, shelved, recommended or rejected):\n${excludes.join('\n') || '(nothing)'}\n\nPropose the long list.`,
    })).data.candidates;
    log('candidates', `${longlist.length} candidates proposed`, { candidates: longlist.map((c) => `${c.title} - ${c.author}${c.reread ? ' (reread)' : ''}`) });

    // 3. Enrich with real data (Goodreads page per book, cached)
    log('enrich', 'Fetching real descriptions, ratings and reviews...');
    const polish = (brief.constraints?.languages || []).some((l) => /^pl|polish|polski/i.test(l));
    const enriched = await mapLimit(longlist, 3, async (c) => {
      try {
        const book = await enrichCandidate(c, { polish });
        if (book) log('enrich', `Found: ${book.title} (${book.ratings_count?.toLocaleString() || '?'} ratings, ${book.reviews?.length || 0} reviews)`, { book: card(book) });
        else log('enrich', `Could not verify: ${c.title} - ${c.author}`);
        return book ? { candidate: c, book } : null;
      } catch (e) { log('enrich', `Failed: ${c.title}: ${e.message}`); return null; }
    });
    // Code-level guards: the same book twice (omnibus vs. book 1, translated title), books already read, shelved,
    // recommended or rejected (the model sometimes forgets the list or proposes a known book under another title),
    // and books far over the page limit.
    const known = gift ? null : knownBooks();
    const maxPages = !path && brief.constraints?.max_pages > 0 ? brief.constraints.max_pages : 0;
    const seenBooks = new Set();
    const found = [];
    const skipped = { known: 0, long: 0 };
    for (const x of enriched.filter(Boolean)) {
      if (seenBooks.has(x.book.id)) continue;
      seenBooks.add(x.book.id);
      if (known && !x.candidate.reread && isKnown(x.book, known)) { skipped.known++; log('enrich', `Skipped (you already know it): ${x.book.title}`, { drop: { id: x.book.id, reason: 'You already know this one (read, saved or suggested before).' } }); continue; }
      if (maxPages && x.book.pages && x.book.pages > maxPages * 1.15) { skipped.long++; log('enrich', `Skipped (${x.book.pages} pages, over your ${maxPages}): ${x.book.title}`, { drop: { id: x.book.id, reason: `${x.book.pages} pages, over your limit of ${maxPages}.` } }); continue; }
      found.push(x);
    }
    if (found.length < 3) {
      const unverified = enriched.filter((x) => !x).length;
      const why = [unverified ? `${unverified} could not be found on Goodreads (connection or throttling)` : '', skipped.known ? `${skipped.known} you already know` : '', skipped.long ? `${skipped.long} were over your page limit` : ''].filter(Boolean).join(', ');
      throw new Error(`Too few usable candidates (${found.length})${why ? ': ' + why : ''}. Try again; each run thinks of a new long list.`);
    }

    // 4. Review digests (cached per book; refreshed when stale)
    const todo = found.filter((x) => digestStale(x.book));
    log('digest', `Reading real reviews for ${todo.length} books (${found.length - todo.length} cached)...`);
    await mapLimit(todo, 4, async (x) => {
      try { x.book.review_digest = await digestBook(x.book); log('digest', `Digested: ${x.book.title}`, { book: card(x.book) }); }
      catch (e) { log('digest', `Digest failed: ${x.book.title}: ${e.message}`); }
    });

    // 5. Rank
    log('rank', path ? 'Assembling the path...' : 'Choosing the final slate...');
    const packed = found.map((x, i) => ({
      index: i, title: x.book.title, author: x.book.author, year: x.book.year, pages: x.book.pages, language: x.book.language,
      genres: x.book.genres.slice(0, 8), rating: x.book.rating, ratings_count: x.book.ratings_count, rating_dist_1to5: x.book.rating_dist,
      series: x.book.extra?.series?.filter((s) => s.title) || [], awards: x.book.extra?.awards?.slice(0, 3) || [],
      description: (x.book.description || '').slice(0, 900), proposed_slot: x.candidate.slot, proposed_why: x.candidate.why, reread: !!x.candidate.reread,
      polish_edition: x.book.extra?.lubimyczytac || null, hardcover_tags: x.book.extra?.hardcover || null,
      review_digest: x.book.review_digest || null,
    }));
    const after = !gift && ctx.after_reading ? `\n\nAFTER RECENT BOOKS (the reader's own debriefs, freshest evidence; match candidates' complaints against what bothered them):\n${[...(ctx.after_reading.patterns || []), ...ctx.after_reading.books.slice(0, 12)].join('\n')}` : '';
    const header = `BRIEF (JSON):\n${JSON.stringify(brief, null, 1)}\n\nREADER DNA:\n${gift ? '(gift: not applicable)' : ctx.reader_dna || '(none yet)'}\n\nTODAY'S ANSWERS:\n${JSON.stringify(ctx.session_answers, null, 1)}${after}\n\nENRICHED CANDIDATES (JSON, index = candidate_index):\n${JSON.stringify(packed, null, 1)}`;
    if (path) {
      const ranked = (await ask({ system: PATH_RANK_SYSTEM, schema: PATH_RANK_SCHEMA, tier: getSetting('tier_rank', 'best'), effort: 'high', prompt: `${header}\n\nAssemble the reading path.` })).data;
      const stageBooks = new Set(ranked.path.map((p) => found[p.candidate_index]?.book.id).filter(Boolean));
      saveSlate(sessionId, (add, used) => {
        let rank = 1;
        for (const p of ranked.path) {
          const x = found[p.candidate_index]; if (!x || used.has(x.book.id)) continue;
          let alt = p.alternate_index >= 0 && p.alternate_index !== p.candidate_index ? found[p.alternate_index] : null;
          if (alt && (stageBooks.has(alt.book.id) || used.has(alt.book.id))) alt = null; // an alternate that is another stage's book is no alternate
          add({ sessionId, bookId: x.book.id, rank: rank++, slot: p.stage, fit: { ...p, kind: 'pick', path: true, why_now: p.why_here, reread: !!x.candidate.reread, alternate: alt ? { book_id: alt.book.id, title: alt.book.title, author: alt.book.author, when: p.alternate_when } : null } });
          if (alt) add({ sessionId, bookId: alt.book.id, rank: 100 + rank, slot: 'alternate_' + p.stage, fit: { kind: 'alternate', stage: p.stage, one_line: p.alternate_when || 'Alternate for this stage' } });
        }
      });
      updateSession(sessionId, { status: 'recommended', ended_at: new Date().toISOString(), brief: { ...brief, note_to_reader: ranked.arc_note, dropped: (ranked.dropped || []).map((d) => ({ title: found[d.candidate_index]?.book?.title, reason: d.reason })) } });
    } else {
      const ranked = (await ask({ system: RANK_SYSTEM, schema: RANK_SCHEMA, tier: getSetting('tier_rank', 'best'), effort: 'high', prompt: `${header}\n\nChoose the slate.` })).data;
      for (const d of ranked.dropped || []) { const x = found[d.candidate_index]; if (x) log('rank', `Set aside: ${x.book.title}`, { drop: { id: x.book.id, reason: d.reason } }); }
      // 6. Second opinion: the same "Should I read this?" judge the book page uses checks every book on the slate,
      // so the slate and the verdicts can no longer contradict each other. Verdicts are stored and shown on the book page.
      const verdicts = new Map();
      const verify = !gift && getSetting('verify_picks', 'true') === 'true';
      let slate = ranked;
      if (verify) {
        slate = await secondOpinion(ranked, found, sessionId, log, verdicts);
        // 6b. Must-haves are rules. When fewer than two books pass them, look once more, narrowly, before saying so.
        if ((brief.must_haves || []).length && slate.picks.length < 2) {
          const added = await rescueRound({ brief, found, verdicts, sessionId, log, polish, excludes, known, web }).catch((e) => { log('rescue', `The second search failed: ${e.message}`); return []; });
          if (added.length) slate = applySecondOpinion({ ...ranked, runners_up: [...(ranked.runners_up || []), ...added.map((i) => ({ candidate_index: i, one_line: '' }))] }, verdicts, found);
        }
      }
      // 6c. Books the reader asked to keep while watching: they are judged like the others and listed whatever the ranking said.
      for (const bookId of keptBooks(sessionId)) {
        let i = found.findIndex((x) => x.book.id === bookId);
        if (i < 0) { const b = getBook(bookId); if (!b) continue; found.push({ candidate: { slot: 'kept by you', why: '', reread: false }, book: b }); i = found.length - 1; }
        if (slate.picks.some((p) => p.candidate_index === i)) continue;
        let v = verdicts.get(i);
        if (!v && !gift) { try { log('verify', `You kept ${found[i].book.title}: reading it properly...`); v = await verdictFor(bookId, { sessionId }); verdicts.set(i, v); } catch (e) { log('verify', `Could not judge ${found[i].book.title}: ${e.message}`); } }
        const not = (arr) => (arr || []).filter((q) => q.candidate_index !== i);
        slate = { ...slate, picks: [...slate.picks, pickFromVerdict(i, v, 'kept by you', { kept: true })], runners_up: not(slate.runners_up), exceptions: not(slate.exceptions), dropped: not(slate.dropped) };
      }
      saveSlate(sessionId, (add) => {
        let rank = 1;
        for (const p of slate.picks) {
          const x = found[p.candidate_index]; if (!x) continue;
          add({ sessionId, bookId: x.book.id, rank: rank++, slot: p.slot, fit: { ...p, kind: 'pick', reread: !!x.candidate.reread } });
        }
        for (const e of slate.exceptions || []) {
          const x = found[e.candidate_index]; if (!x) continue;
          add({ sessionId, bookId: x.book.id, rank: 50 + rank++, slot: 'exception', fit: { kind: 'exception', missing: e.missing, worth_it_because: e.worth_it_because, check: e.check || null } });
        }
        for (const r of slate.runners_up || []) {
          const x = found[r.candidate_index]; if (!x) continue;
          add({ sessionId, bookId: x.book.id, rank: 100 + rank++, slot: 'runner_up', fit: { kind: 'runner_up', one_line: r.one_line, check: r.check || null } });
        }
      });
      updateSession(sessionId, { status: 'recommended', ended_at: new Date().toISOString(), brief: {
        ...brief, note_to_reader: slate.note_to_reader, pool: found.map((x) => x.book.id), must_report: mustReport(brief, verdicts),
        dropped: (slate.dropped || []).map((d) => ({ book_id: found[d.candidate_index]?.book?.id, title: found[d.candidate_index]?.book?.title, reason: d.reason })).filter((d) => d.title),
      } });
    }
    log('done', 'Done');
  } catch (e) {
    failed = true;
    log('error', e.message);
    // A failed re-run leaves the earlier slate in place and the session as it was.
    updateSession(sessionId, statusBefore === 'recommended' ? { status: 'recommended', brief: briefBefore, summary: summaryBefore } : { status: 'interview' });
    throw e;
  } finally {
    keepers.delete(sessionId);
    // After a failure the session can be retried at once; after success the log stays a minute for late listeners.
    const entry = running.get(sessionId);
    if (failed && entry) entry.failed = true;
    setTimeout(() => { if (running.get(sessionId) === entry) running.delete(sessionId); }, failed ? 20_000 : 60_000);
  }
}

// Is this book one the reader already knows (read, shelved, recommended before)? By id, Goodreads id, or close title + author.
// Titles are compared whole (series brackets dropped, subtitle kept), so "Dune" never hides "Dune Messiah".
const fullTitle = (s = '') => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9\u00C0-\u024F ]+/g, ' ').replace(/\s+/g, ' ').trim();
export function isKnown(book, known) {
  if (known.ids.has(book.id) || (book.goodreads_id && known.gids.has(String(book.goodreads_id)))) return true;
  const t = fullTitle(book.title), ln = lastName(book.author || '');
  if (!t) return false;
  return known.keys.some((k) => {
    const kt = fullTitle(k.title);
    const sameAuthor = k.author && ln ? k.author.toLowerCase().includes(ln) : null;
    if (kt === t) return sameAuthor !== false;
    // "Title: Subtitle" against plain "Title" (two words or more), only when the author is known to match.
    if (sameAuthor !== true || k.title.includes(':') === book.title.includes(':')) return false;
    const a = fullTitle(k.title.split(':')[0]), b = fullTitle(book.title.split(':')[0]);
    return a === b && a.split(' ').length >= 2;
  });
}

// ---------- second opinion ----------
const GOOD = ['yes', 'probably'];
const EXCEPTION_FIT = 58; // a must-have miss is worth showing only when the book is otherwise a strong fit
const VLABEL = { yes: 'yes', probably: 'probably', maybe: 'maybe', probably_not: 'probably not', no: 'no' };
// Pure: reshapes the ranked slate given one verdict per candidate index (Map). Exported for tests.
export function applySecondOpinion(ranked, verdicts, found) {
  const title = (i) => found[i]?.book?.title || '?';
  const missing = (v) => (v?.must_haves_missing || []).filter(Boolean);
  const picks = [], runners = [], exceptions = [], promotable = [];
  const dropped = [...(ranked.dropped || [])];
  const seen = new Set();
  const route = (i, v, asPick) => {
    if (seen.has(i)) return; seen.add(i);
    if (!v) { if (asPick) picks.push(asPick); else runners.push({ candidate_index: i, one_line: ranked.runners_up.find((r) => r.candidate_index === i)?.one_line || '' }); return; }
    const miss = missing(v);
    if (miss.length) {
      if (v.fit >= EXCEPTION_FIT) exceptions.push({ candidate_index: i, missing: miss.join('; '), worth_it_because: v.headline, check: check(v) });
      else dropped.push({ candidate_index: i, reason: `Misses your must-have (${miss.join('; ')}).` });
    } else if (GOOD.includes(v.verdict)) {
      if (asPick) picks.push({ ...asPick, check: check(v) });
      else promotable.push({ i, v });
    } else if (v.verdict === 'maybe') {
      runners.push({ candidate_index: i, one_line: `Borderline on a second look: ${v.headline}`, check: check(v) });
    } else {
      dropped.push({ candidate_index: i, reason: `Failed the second look (${VLABEL[v.verdict]}, ${v.fit}%): ${v.headline}` });
    }
  };
  for (const p of ranked.picks) route(p.candidate_index, verdicts.get(p.candidate_index), p);
  for (const r of ranked.runners_up || []) route(r.candidate_index, verdicts.get(r.candidate_index), null);
  for (const e of ranked.exceptions || []) {
    const i = e.candidate_index; if (seen.has(i)) continue;
    const v = verdicts.get(i);
    if (!v) { seen.add(i); exceptions.push(e); continue; }
    if (missing(v).length && !GOOD.includes(v.verdict) && v.verdict !== 'maybe') { seen.add(i); dropped.push({ candidate_index: i, reason: `Misses your must-have (${e.missing}) and the second look was ${VLABEL[v.verdict]}.` }); continue; }
    route(i, v, null); // the judge decides: still an exception, a full candidate after all, a runner-up, or out
    const x = exceptions.find((q) => q.candidate_index === i); if (x) x.worth_it_because = e.worth_it_because || x.worth_it_because;
  }
  // Runners-up the judge liked fill the slate back up to three; they are written from the verdict.
  promotable.sort((a, b) => b.v.fit - a.v.fit);
  for (const { i, v } of promotable) {
    if (picks.length < MAX_PICKS) {
      picks.push(pickFromVerdict(i, v, 'also a good fit', { promoted: true }));
    } else runners.push({ candidate_index: i, one_line: `Also a "${VLABEL[v.verdict]}" (${v.fit}%): ${v.headline}`, check: check(v) });
  }
  const inPicks = (i) => picks.some((q) => q.candidate_index === i);
  const inExc = (i) => exceptions.some((q) => q.candidate_index === i);
  const removed = ranked.picks.filter((p) => !inPicks(p.candidate_index) && !inExc(p.candidate_index)).map((p) => title(p.candidate_index));
  const moved = ranked.picks.filter((p) => inExc(p.candidate_index)).map((p) => title(p.candidate_index));
  // The ranker's note talks about its own picks; once any of them is removed it would contradict the page, so it is replaced.
  let note = removed.length || moved.length ? [
    removed.length ? `After a second, stricter look I took out ${removed.join(', ')}; the reasons are under "The brief".` : '',
    moved.length ? `${moved.join(', ')} ${moved.length > 1 ? 'miss' : 'misses'} one of your must-haves, so ${moved.length > 1 ? 'they are' : 'it is'} under "Worth breaking a must-have?".` : '',
  ].filter(Boolean).join(' ') : ranked.note_to_reader || '';
  if (!picks.length) {
    const tally = {};
    for (const [, v] of verdicts) for (const m of missing(v)) { const k = m.split(' (')[0].trim(); tally[k] = (tally[k] || 0) + 1; }
    const worst = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    note += ` Nothing passed the second look cleanly, so there are no picks this time.${worst ? ` The must-have that ruled out the most books was "${worst[0]}" (${worst[1]} of ${verdicts.size}).` : ''} The closest calls are below; "Same answers, different picks" tries a fresh long list.`;
  }
  // Never an empty page: when nothing passes, the two closest calls are shown with their honest verdicts.
  if (!picks.length && !runners.length) {
    const closest = [...verdicts].filter(([i]) => !exceptions.some((e) => e.candidate_index === i)).sort((a, b) => b[1].fit - a[1].fit).slice(0, 2);
    for (const [i, v] of closest) {
      runners.push({ candidate_index: i, one_line: `Closest call (${VLABEL[v.verdict]}, ${v.fit}%): ${v.headline}`, check: check(v) });
      const k = dropped.findIndex((d) => d.candidate_index === i); if (k >= 0) dropped.splice(k, 1);
    }
  }
  // Best fit first: the list is read top down, and the number beside each book must agree with its place.
  if (picks.length > 1 && picks.every((p) => p.check)) picks.sort((a, b) => b.check.fit - a.check.fit);
  for (const x of exceptions.slice(3)) dropped.push({ candidate_index: x.candidate_index, reason: `Misses your must-have (${x.missing}); fewer exceptions shown.` });
  for (const x of runners.slice(5)) dropped.push({ candidate_index: x.candidate_index, reason: x.one_line || 'Not among the closest calls.' });
  return { ...ranked, picks, runners_up: runners.slice(0, 5), exceptions: exceptions.slice(0, 3), dropped, note_to_reader: note };
}

// What the slate keeps of a verdict: the answer, both fit numbers (for today, and in general), the at-a-glance labels.
function check(v) { return v ? { verdict: v.verdict, fit: v.fit, fit_general: v.fit_general ?? null, headline: v.headline, glance: v.glance || null, missing: (v.must_haves_missing || []).filter(Boolean) } : null; }
// A pick written from the judge's verdict (a runner-up it liked, a book from the second search, a book the reader kept).
function pickFromVerdict(i, v, slot, extra = {}) {
  if (!v) return { candidate_index: i, slot, headline: 'You asked to keep this one.', why_now: '', what_readers_love: '', what_readers_complain: '', risk_for_you: '', read_if: '', skip_if: '', first_pages: '', audio_note: '', confidence: 0, check: null, ...extra };
  return { candidate_index: i, slot, honest_verdict: v.verdict, headline: v.headline, why_now: v.why, what_readers_love: v.you_will_love, what_readers_complain: v.will_bother_you, risk_for_you: v.biggest_risk, read_if: v.best_moment, skip_if: v.not_now_if, first_pages: v.first_pages, audio_note: v.audio_note || '', confidence: v.confidence, check: check(v), ...extra };
}
// Which must-have ruled out how many of the judged books: shown when nothing (or little) passed, so the reader sees the bottleneck.
function mustReport(brief, verdicts) {
  const musts = brief.must_haves || [];
  if (!musts.length || !verdicts.size) return null;
  const name = (m) => String(m).split(':')[0].trim();
  const tally = new Map(musts.map((m) => [name(m), 0])); let passed = 0;
  for (const [, v] of verdicts) {
    const miss = (v.must_haves_missing || []).filter(Boolean);
    if (!miss.length) passed++;
    for (const x of miss) { const k = [...tally.keys()].find((m) => name(x).toLowerCase() === m.toLowerCase() || String(x).toLowerCase().includes(m.toLowerCase())) || name(x); tally.set(k, (tally.get(k) || 0) + 1); }
  }
  return { judged: verdicts.size, passed_all: passed, failed: [...tally].map(([must, count]) => ({ must, count })).sort((a, b) => b.count - a.count) };
}

// The second search: asked only when fewer than two books passed the must-haves. It sees what failed and why.
async function rescueRound({ brief, found, verdicts, sessionId, log, polish, excludes, known, web }) {
  log('rescue', 'Too few books passed your must-haves. Searching once more, narrowly...');
  const judged = [...verdicts].map(([i, v]) => `${found[i].book.title} - ${found[i].book.author}: ${v.must_haves_missing?.length ? 'FAILED: ' + v.must_haves_missing.join('; ') : `${VLABEL[v.verdict]}, ${v.fit}%`}`);
  const list = (await ask({
    system: CANDIDATES_SYSTEM, schema: RESCUE_SCHEMA, tier: getSetting('tier_candidates', 'best'), effort: 'high', web, maxTurns: 18,
    prompt: `BRIEF (JSON):\n${JSON.stringify(brief, null, 1)}\n\nSECOND ROUND. A first long list was researched and each book judged against real reviews; too few had every must-have. What the judge found:\n${judged.join('\n')}\n\nALREADY CONSIDERED (do not repeat):\n${found.map((x) => `${x.book.title} - ${x.book.author}`).join('\n')}\n\nDO NOT RECOMMEND (already read, shelved, recommended or rejected):\n${excludes.join('\n') || '(nothing)'}\n\nPropose 3 to 10 DIFFERENT books that pass every must-have test beyond doubt, judged by what readers actually say about them and by the reference books in must_examples. In this round certainty about the must-haves matters more than variety, and slots do not matter. Learn from the failures above: they show how the tests are applied. Only books you are confident about; fewer is better than doubtful.`,
  })).data.candidates;
  log('rescue', `${list.length} more candidates`, { candidates: list.map((c) => `${c.title} - ${c.author}`) });
  const have = new Set(found.map((x) => x.book.id));
  const fresh = [];
  // One at a time and unhurried: this round comes right after a burst of page fetches, when Goodreads throttles most.
  await mapLimit(list, 1, async (c) => {
    try {
      await sleep(1500);
      const book = await enrichCandidate(c, { polish });
      if (!book) { log('rescue', `Could not verify: ${c.title} - ${c.author}`); return; }
      if (have.has(book.id) || (known && isKnown(book, known))) { log('rescue', `Already considered or known to you: ${book.title}`); return; }
      have.add(book.id); log('enrich', `Found: ${book.title}`, { book: card(book) });
      if (digestStale(book)) { book.review_digest = await digestBook(book); log('digest', `Digested: ${book.title}`, { book: card(book) }); }
      fresh.push({ candidate: c, book });
    } catch (e) { log('rescue', `Failed: ${c.title}: ${e.message}`); }
  });
  const added = [];
  await mapLimit(fresh, 4, async (x) => {
    const i = found.push(x) - 1;
    try {
      const v = await verdictFor(x.book.id, { sessionId }); verdicts.set(i, v); added.push(i);
      log('verify', `${x.book.title}: ${VLABEL[v.verdict]} (${v.fit}%)${v.must_haves_missing?.length ? ', misses a must-have' : ''}`, { verdict: { id: x.book.id, verdict: v.verdict, fit: v.fit, missing: v.must_haves_missing || [] } });
    } catch (e) { log('verify', `Could not check ${x.book.title}: ${e.message}`); }
  });
  return added;
}

async function secondOpinion(ranked, found, sessionId, log, verdicts = new Map()) {
  const idx = [...new Set([...ranked.picks, ...(ranked.runners_up || []), ...(ranked.exceptions || [])].map((x) => x.candidate_index))].filter((i) => found[i]);
  log('verify', `Second opinion: asking "Should I read this?" about ${idx.length} books...`);
  await mapLimit(idx, 4, async (i) => {
    try {
      const v = await verdictFor(found[i].book.id, { sessionId });
      verdicts.set(i, v);
      log('verify', `${found[i].book.title}: ${VLABEL[v.verdict]} (${v.fit}%)${v.must_haves_missing?.length ? ', misses a must-have' : ''}`, { verdict: { id: found[i].book.id, verdict: v.verdict, fit: v.fit, missing: v.must_haves_missing || [] } });
    } catch (e) { log('verify', `Could not check ${found[i].book.title}: ${e.message}`); }
  });
  return applySecondOpinion(ranked, verdicts, found);
}

// ---------- enrichment ----------
function norm(s = '') { return s.toLowerCase().replace(/\(.*?\)/g, '').split(':')[0].replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function lastName(a = '') { const parts = a.trim().split(/\s+/); return (parts[parts.length - 1] || '').toLowerCase(); }
export function titleMatch(a, b) {
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

// Polish edition: rating on a 1-10 scale, translator, plus real Polish reviews merged into the review set for the digest.
async function attachPolish(book, c) {
  let hits = [];
  try { hits = await searchLubimyczytac(`${c.title} ${c.author}`); } catch {}
  const ln = lastName(c.author);
  if (!ln) return null; // without an author every Polish book would "match"
  if (!hits.length) { try { hits = await searchLubimyczytac(c.author); } catch {} }
  const byTitle = hits.find((x) => x.author.toLowerCase().includes(ln) && titleMatch(x.title, c.title) > 0.5);
  const byAuthor = !byTitle && hits.length <= 3 ? hits.find((x) => x.author.toLowerCase().includes(ln)) : null;
  const hit = byTitle || byAuthor;
  if (!hit) return null;
  await sleep(300);
  const lc = await fetchLubimyczytacBook(hit.url);
  // A Polish title rarely matches the English one, so an author-only hit must prove itself with its original title.
  if (byAuthor && !(lc.originalTitle && titleMatch(lc.originalTitle, c.title) >= 0.6)) return null;
  if (lc.originalTitle && titleMatch(lc.originalTitle, c.title) < 0.5 && titleMatch(lc.title, c.title) < 0.5) return null;
  const extra = { ...(book.extra || {}), lubimyczytac: { url: lc.url, polishTitle: lc.title, rating10: lc.rating10, ratingsCount: lc.ratingsCount, pages: lc.pages, translator: lc.translator, audiobook: lc.audiobook, checkedAt: new Date().toISOString() } };
  const reviews = [...(book.reviews || []).filter((r) => r.source !== 'lubimyczytac'), ...lc.reviews.slice(0, 12)];
  // New Polish reviews change what the digest should say: mark it for a refresh.
  db.prepare('UPDATE books SET extra = ?, reviews = ?, digested_at = NULL WHERE id = ?').run(JSON.stringify(extra), JSON.stringify(reviews), book.id);
  book.extra = extra; book.reviews = reviews;
  return extra.lubimyczytac;
}
// On demand from the book page: is there a Polish edition, who translated it, is there an audiobook?
export async function lookupPolish(bookId) {
  const book = getBook(bookId);
  if (!book) throw new Error('no such book');
  const found = await attachPolish(book, { title: book.title, author: book.author || '' });
  if (!found) {
    const extra = { ...(book.extra || {}), lubimyczytac: null, polishChecked: new Date().toISOString() };
    db.prepare('UPDATE books SET extra = ? WHERE id = ?').run(JSON.stringify(extra), book.id);
  }
  return found;
}

export async function digestBook(book) {
  const reviews = (book.reviews || []).slice(0, 48).map((r, i) => `#${i + 1} [${r.rating ?? '?'}/5${r.rating10 ? ' (' + r.rating10 + '/10 PL)' : ''}, ${r.likes} likes${r.createdAt ? ', ' + r.createdAt : ''}${r.source === 'lubimyczytac' ? ', Polish reader on lubimyczytac.pl' : ''}${r.critical ? ', from the lowest-rated reviews' : ''}]${r.shelves?.length ? ' shelves: ' + r.shelves.join(', ') : ''}\n${r.text.slice(0, 1400)}`).join('\n\n');
  const hc = book.extra?.hardcover ? `\nHardcover.app crowd tags: moods ${JSON.stringify(book.extra.hardcover.moods)}, genres ${JSON.stringify(book.extra.hardcover.genres)}, content warnings ${JSON.stringify(book.extra.hardcover.contentWarnings)}.` : '';
  const pl = book.extra?.lubimyczytac ? `\nPolish edition "${book.extra.lubimyczytac.polishTitle}": ${book.extra.lubimyczytac.rating10}/10 from ${book.extra.lubimyczytac.ratingsCount} Polish readers.` : '';
  const series = (book.extra?.series || []).filter((x) => x.title).map((x) => `${x.title}${x.position ? ' #' + x.position : ''}`);
  const prompt = `BOOK: ${book.title} by ${book.author} (${book.year || '?'}), ${book.pages || '?'} pages. Genres: ${book.genres.join(', ')}.
Average ${book.rating} from ${book.ratings_count?.toLocaleString()} ratings. Distribution 1..5 stars: ${JSON.stringify(book.rating_dist)}.${hc}${pl}
Series (Goodreads): ${series.join('; ') || 'none listed'}.

DESCRIPTION:
${(book.description || '').slice(0, 2500)}

REAL READER REVIEWS (${(book.reviews || []).length}; the most-liked ones first, then, when marked, the lowest-rated ones):
${reviews || '(none available)'}

Write the digest.`;
  const { data } = await ask({ system: DIGEST_SYSTEM, prompt, schema: DIGEST_SCHEMA, tier: getSetting('tier_digest', 'fast'), effort: 'low', timeoutMs: 150_000 });
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

// ---------- adjusting a finished slate without new research ----------
// "More romance", "better written", "like the second one": the books already researched for this session are ranked
// again for the change she asks for. One model call, no fetching.
export async function nudgeSlate(sessionId, text) {
  if (isRunning(sessionId)) throw new Error('Still researching; wait for the list first.');
  const session = getSession(sessionId);
  if (!session?.brief) throw new Error('Nothing to adjust yet.');
  if (session.mode === 'path') throw new Error('A reading path is built in order; start a new one instead.');
  const brief = session.brief;
  const recs = getRecommendations(sessionId);
  const old = new Map(recs.map((r) => [r.book_id, r]));
  const ids = [...new Set([...(brief.pool || []), ...recs.map((r) => r.book_id)])];
  const books = ids.map((id) => getBook(id)).filter((b) => b && old.get(b.id)?.feedback !== 'not_for_me');
  if (books.length < 2) throw new Error('Too few researched books to choose from; run a new search.');
  const gift = session.mode === 'gift';
  const ctx = gift ? { session_answers: answersDigest(sessionId) } : fullContext(sessionId);
  const judgement = (b) => { const v = latestVerdict(b.id)?.verdict; return v ? { verdict: v.verdict, fit: v.fit, must_haves_missing: v.must_haves_missing, will_bother_you: v.will_bother_you, headline: v.headline } : undefined; };
  const packed = books.map((b, i) => ({
    index: i, title: b.title, author: b.author, year: b.year, pages: b.pages, genres: b.genres.slice(0, 8), rating: b.rating, ratings_count: b.ratings_count, rating_dist_1to5: b.rating_dist,
    description: (b.description || '').slice(0, 700), review_digest: b.review_digest || null, earlier_judgement: gift ? undefined : judgement(b),
    on_the_list_now_as: old.get(b.id)?.fit?.kind || 'set aside earlier', her_reaction: old.get(b.id)?.feedback || undefined,
  }));
  const nudges = [...(brief.nudges || []), { text, at: dbNow() }];
  const prompt = `BRIEF (JSON):\n${JSON.stringify({ ...brief, pool: undefined, dropped: undefined, must_report: undefined, nudges: undefined }, null, 1)}\n\nREADER DNA:\n${gift ? '(gift: not applicable)' : ctx.reader_dna || '(none yet)'}\n\nTODAY'S ANSWERS:\n${JSON.stringify(ctx.session_answers, null, 1)}\n\nADJUSTMENT. The reader has seen the current list and asks for a change, in her words: "${text}".${nudges.length > 1 ? ` Earlier adjustments in this session, oldest first: ${nudges.slice(0, -1).map((n) => `"${n.text}"`).join(', ')}.` : ''}\nRank the SAME researched candidates again for that. Where the adjustment and the original brief conflict, the adjustment wins, except for must-haves and hard excludes, which stand unless she explicitly lifts one. A book whose earlier_judgement lists must_haves_missing stays out of the picks unless the adjustment lifts that must-have. "More like <a book on the list>" means its appeal factors, read from its digest. In each why_now say how the book answers the adjustment. If these candidates cannot honestly deliver the change, pick the few that come closest and say plainly in note_to_reader that a fresh search would do better; never pad.\n\nENRICHED CANDIDATES (JSON, index = candidate_index):\n${JSON.stringify(packed, null, 1)}\n\nChoose the slate.`;
  const ranked = (await ask({ system: RANK_SYSTEM, schema: RANK_SCHEMA, tier: getSetting('tier_rank', 'best'), effort: 'medium', prompt })).data;
  const carry = (bookId, newId) => { const o = old.get(bookId); if (newId && o?.feedback) setRecommendationFeedback(newId, o.feedback, o.feedback_note, o.outcome || null); };
  const chk = (b) => check(latestVerdict(b.id)?.verdict);
  saveSlate(sessionId, (add) => {
    let rank = 1;
    for (const p of ranked.picks) { const b = books[p.candidate_index]; if (!b) continue; carry(b.id, add({ sessionId, bookId: b.id, rank: rank++, slot: p.slot, fit: { ...p, kind: 'pick', nudged: true, check: gift ? null : chk(b) } })); }
    for (const e of ranked.exceptions || []) { const b = books[e.candidate_index]; if (!b) continue; carry(b.id, add({ sessionId, bookId: b.id, rank: 50 + rank++, slot: 'exception', fit: { kind: 'exception', missing: e.missing, worth_it_because: e.worth_it_because, check: gift ? null : chk(b) } })); }
    for (const r of ranked.runners_up || []) { const b = books[r.candidate_index]; if (!b) continue; carry(b.id, add({ sessionId, bookId: b.id, rank: 100 + rank++, slot: 'runner_up', fit: { kind: 'runner_up', one_line: r.one_line, check: gift ? null : chk(b) } })); }
  });
  updateSession(sessionId, { brief: { ...brief, nudges, note_to_reader: ranked.note_to_reader, pool: ids, dropped: (ranked.dropped || []).map((d) => ({ book_id: books[d.candidate_index]?.id, title: books[d.candidate_index]?.title, reason: d.reason })).filter((d) => d.title) } });
  addAnswer({ sessionId, qId: 'nudge', layer: 'checkin', question: 'After seeing the list, the reader asked for this change', options: null, answer: null, freeText: text });
  return { ok: true, picks: ranked.picks.length };
}

// "Add it anyway": a book the tool set aside (or any researched book) goes onto the list at the reader's word, with an honest verdict.
export async function addBookToSlate(sessionId, bookId) {
  const session = getSession(sessionId);
  const book = getBook(bookId);
  if (!session || !book) throw new Error('no such session or book');
  const recs = getRecommendations(sessionId);
  if (recs.some((r) => r.book_id === bookId && r.fit?.kind === 'pick')) return { ok: true, already: true };
  let v = null; try { v = session.mode === 'gift' ? null : await verdictFor(bookId, { sessionId }); } catch {}
  db.prepare('UPDATE recommendations SET superseded_at = ? WHERE session_id = ? AND book_id = ? AND superseded_at IS NULL').run(dbNow(), sessionId, bookId);
  const rank = Math.max(0, ...recs.filter((r) => r.fit?.kind === 'pick').map((r) => r.rank || 0)) + 1;
  addRecommendation({ sessionId, bookId, rank, slot: 'added by you', fit: { ...pickFromVerdict(0, v, 'added by you', { kept: true }), candidate_index: undefined, kind: 'pick' } });
  const brief = session.brief || {};
  updateSession(sessionId, { brief: { ...brief, dropped: (brief.dropped || []).filter((d) => d.book_id !== bookId) } });
  return { ok: true };
}
