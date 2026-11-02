// Talking about books: conversation about one book or a slate, the "should I read this?" verdict,
// a Markdown export of a slate, and the weekly automatic Reader DNA rebuild.
import { ask } from '../llm.js';
import { chatSystem, VERDICT_SCHEMA, VERDICT_SYSTEM, CHOOSE_SCHEMA, CHOOSE_SYSTEM } from '../prompts.js';
import { debriefPatterns } from './evidence.js';
import * as DB from '../db.js';
import { fullContext, answersDigest, traitProfile, readerDna } from './context.js';
import { digestBook } from './recommend.js';
import { reflectProfile } from './reflect.js';
import { onboardingDone } from './interview.js';

// ---------- material ----------
function bookMaterial(b, { reviews = 20 } = {}) {
  return {
    title: b.title, author: b.author, year: b.year, pages: b.pages, language: b.language, genres: b.genres.slice(0, 8),
    rating: b.rating, ratings_count: b.ratings_count, rating_dist_1to5: b.rating_dist,
    series: b.extra?.series?.filter((s) => s.title) || [], awards: b.extra?.awards?.slice(0, 4) || [],
    polish_edition: b.extra?.lubimyczytac || null, hardcover_tags: b.extra?.hardcover || null,
    description: (b.description || '').slice(0, 2500),
    review_digest: b.review_digest || null,
    reviews: (b.reviews || []).slice(0, reviews).map((r) => ({ rating: r.rating ?? r.rating10, likes: r.likes, source: r.source || 'goodreads', text: r.text.slice(0, 700) })),
    goodreads_url: b.url,
  };
}

function readerMaterial({ sessionId = null, full = false } = {}) {
  const ctx = full ? fullContext(sessionId) : { reader_dna: readerDna(), trait_profile: compactTraits() };
  if (!full && sessionId) ctx.session_answers = answersDigest(sessionId);
  ctx.recent_moods = DB.moodLog(6);
  return ctx;
}
function compactTraits() {
  const t = traitProfile();
  const keep = ['loved_books', 'abandoned_books', 'doorway', 'pace_baseline', 'prose_baseline', 'feel_vs_think', 'dealbreakers', 'turnoffs', 'genres_avoid', 'genres_love', 'length_series', 'languages', 'formats', 'proxies', 'why_read'];
  const out = {};
  for (const k of keep) if (t[k]) out[k] = t[k].value?.labels?.length ? { labels: t[k].value.labels, text: t[k].value.text || undefined } : t[k].value?.text || t[k].value;
  for (const [k, v] of Object.entries(t)) if (k.startsWith('inferred_') || k.startsWith('rejected_')) out[k] = v.value;
  return out;
}

function slateMaterial(sessionId) {
  const s = DB.getSession(sessionId);
  if (!s) return null;
  const recs = DB.getRecommendations(sessionId);
  return {
    date: s.started_at.slice(0, 10),
    brief: s.brief ? { reader_now: s.brief.reader_now, need: s.brief.need, appeal_targets: s.brief.appeal_targets, constraints: s.brief.constraints, hard_excludes: s.brief.hard_excludes, soft_avoid: s.brief.soft_avoid, slots: s.brief.slots, note_to_reader: s.brief.note_to_reader, dropped: s.brief.dropped } : null,
    picks: recs.filter((r) => r.fit?.kind === 'pick').map((r) => ({ book_id: r.book_id, title: r.title, author: r.author, year: r.year, pages: r.pages, slot: r.slot, fit: r.fit, one_line: r.review_digest?.one_line, feedback: r.feedback })),
    runners_up: recs.filter((r) => r.fit?.kind === 'runner_up').map((r) => ({ book_id: r.book_id, title: r.title, author: r.author, one_line: r.fit.one_line })),
  };
}

// ---------- chat ----------
export function loadChat({ bookId, sessionId }) {
  return DB.getChat(bookId || null, sessionId || null);
}

/** Streams a reply. onEvent gets {type:'delta',text} | {type:'tool',name} | {type:'done',chat} | {type:'error',message}. */
export async function chat({ bookId, sessionId, message, page = null, onEvent, abortController }) {
  const book = bookId ? DB.getBook(bookId) : null;
  if (bookId && !book) throw new Error('no such book');
  const existing = DB.getChat(bookId || null, sessionId || null);
  const messages = existing ? existing.messages : [];
  messages.push({ role: 'user', text: message, at: DB.now() });
  const scope = book ? 'book' : 'slate';
  const material = {
    reader: readerMaterial({ sessionId }),
    book: book ? bookMaterial(book) : undefined,
    recommendation: book && sessionId ? DB.getRecommendations(sessionId).find((r) => r.book_id === book.id)?.fit || null : undefined,
    slate: sessionId ? slateMaterial(sessionId) : undefined,
    verdict: book ? DB.latestVerdict(book.id)?.verdict || undefined : undefined,
    reading_progress: page ? { page, of: book?.pages || null } : undefined,
    reader_dnf_history: page ? DB.getFacts({ kind: 'trait' }).filter((f) => f.key.startsWith('dnf_') || f.key === 'abandoned_books').map((f) => f.value?.text || f.value?.note || JSON.stringify(f.value)).slice(0, 8) : undefined,
  };
  const transcript = messages.slice(0, -1).slice(-16).map((m) => `${m.role === 'user' ? 'READER' : 'ADVISOR'}: ${m.text}`).join('\n\n');
  const prompt = `MATERIAL (JSON):\n${JSON.stringify(material, null, 1)}\n\n${transcript ? `CONVERSATION SO FAR:\n${transcript}\n\n` : ''}READER: ${message}\n\nReply as the advisor.`;
  const web = DB.getSetting('chat_web', 'true') === 'true';
  let reply;
  try {
    const { data } = await ask({ system: chatSystem({ scope, page }), prompt, tier: DB.getSetting('tier_chat', 'smart'), effort: 'medium', web, maxTurns: web ? 8 : 2, onEvent, abortController });
    reply = String(data || '').trim();
  } catch (e) {
    messages.pop();
    throw e;
  }
  messages.push({ role: 'assistant', text: reply, at: DB.now() });
  const id = DB.saveChat({ id: existing?.id, bookId: bookId || null, sessionId: sessionId || null, messages });
  const chatRow = { id, book_id: bookId || null, session_id: sessionId || null, messages };
  onEvent?.({ type: 'done', chat: chatRow });
  return chatRow;
}

// ---------- verdict ----------
// sessionId: judge against that interview (used by the slate's second opinion); otherwise the latest check-in of the last week.
export async function verdictFor(bookId, { onEvent, sessionId = null } = {}) {
  let book = DB.getBook(bookId);
  if (!book) throw new Error('no such book');
  if (DB.digestStale(book)) { onEvent?.({ step: 'digest', msg: 'Reading the real reviews...' }); await digestBook(book); book = DB.getBook(bookId); }
  onEvent?.({ step: 'verdict', msg: 'Judging it against your profile...' });
  const ctx = fullContext(null);
  const last = sessionId ? DB.getSession(sessionId) : DB.listSessions(5).find((s) => !['onboarding', 'gift'].includes(s.mode) && s.status !== 'closed');
  const recentCheckin = last && (sessionId || Date.now() - Date.parse(last.started_at) < 7 * 864e5)
    ? { date: last.started_at.slice(0, 10), answers: answersDigest(last.id).filter((a) => a.layer !== 'onboarding'), must_haves: last.brief?.must_haves || [], hard_excludes: last.brief?.hard_excludes || [], constraints: last.brief?.constraints || null }
    : null;
  const prompt = `READER (JSON):\n${JSON.stringify({ ...ctx, recent_moods: DB.moodLog(6), most_recent_checkin: recentCheckin }, null, 1)}\n\nBOOK (JSON):\n${JSON.stringify(bookMaterial(book, { reviews: 24 }), null, 1)}\n\nShould this reader read this book?`;
  const { data } = await ask({ system: VERDICT_SYSTEM, prompt, schema: VERDICT_SCHEMA, tier: DB.getSetting('tier_verdict', 'best'), effort: 'high' });
  DB.addVerdict(bookId, data);
  return data;
}

// ---------- export ----------
export function exportSlateMarkdown(sessionId) {
  const s = DB.getSession(sessionId);
  if (!s) throw new Error('no such session');
  const recs = DB.getRecommendations(sessionId);
  const picks = recs.filter((r) => r.fit?.kind === 'pick');
  const runners = recs.filter((r) => r.fit?.kind === 'runner_up');
  const b = s.brief || {};
  const L = [];
  L.push(`# Books for ${new Date(s.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, '');
  if (b.reader_now) L.push(`_${b.reader_now}_`, '');
  if (b.note_to_reader) L.push(b.note_to_reader, '');
  if (b.stages?.length) L.push(`**The arc:** ${b.arc || ''}. ${b.destination ? 'Destination: ' + b.destination : ''}`, '');
  picks.forEach((r, i) => {
    const f = r.fit;
    L.push(`## ${f.path ? 'Stage ' + (i + 1) + ': ' : i + 1 + '. '}${r.title}`, `${r.author}${r.year ? `, ${r.year}` : ''}${r.pages ? `, ${r.pages} pages` : ''} · ${(r.slot || '').replace(/_/g, ' ')}${r.rating ? ` · ★ ${Number(r.rating).toFixed(2)} from ${Number(r.ratings_count || 0).toLocaleString('en-GB')} ratings` : ''}`, '');
    L.push(`**${f.headline}**`, '', f.why_now, '');
    if (f.path) { if (f.checkpoint) L.push(`- **Checkpoint:** ${f.checkpoint}`); if (f.transition) L.push(`- **Then:** ${f.transition}`); if (f.alternate) L.push(`- **Alternate:** ${f.alternate.title} (${f.alternate.author}), ${f.alternate.when}`); }
    L.push(`- **Readers love:** ${f.what_readers_love}`, `- **Readers complain:** ${f.what_readers_complain}`, `- **Risk for you:** ${f.risk_for_you}`, `- **The opening:** ${f.first_pages}`, `- **Read if:** ${f.read_if}`, `- **Skip if:** ${f.skip_if}`);
    if (f.audio_note) L.push(`- **Audio:** ${f.audio_note}`);
    if (r.url) L.push(`- ${r.url}`);
    L.push('');
  });
  const exceptions = recs.filter((r) => r.fit?.kind === 'exception');
  if (exceptions.length) { L.push('## Worth breaking a must-have?', ''); for (const r of exceptions) L.push(`- **${r.title}** (${r.author}): misses "${r.fit.missing}". ${r.fit.worth_it_because}`); L.push(''); }
  if (runners.length) { L.push('## Also considered', ''); for (const r of runners) L.push(`- **${r.title}** (${r.author}): ${r.fit.one_line}`); L.push(''); }
  if (b.dropped?.length) { L.push('## Dropped after reading reviews', ''); for (const d of b.dropped) L.push(`- ${d.title}: ${d.reason}`); L.push(''); }
  L.push('---', 'Made with Book Finder from real Goodreads reviews.');
  return L.join('\n');
}

// ---------- weekly automatic Reader DNA rebuild ----------
export async function maybeAutoReflect({ force = false } = {}) {
  if (!force && DB.getSetting('auto_reflect', 'true') !== 'true') return { ran: false, reason: 'off' };
  if (!onboardingDone()) return { ran: false, reason: 'no taste profile yet' };
  const last = DB.getSetting('last_reflect_at');
  const due = force || !last || Date.now() - Date.parse(last) > 7 * 864e5;
  if (!due) return { ran: false, reason: 'not due', last };
  const stamp = DB.evidenceStamp();
  if (!force && stamp === DB.getSetting('last_reflect_stamp')) return { ran: false, reason: 'no new evidence', last };
  console.log('[auto-reflect] rebuilding Reader DNA');
  await reflectProfile();
  DB.setSetting('last_reflect_stamp', stamp);
  return { ran: true };
}
export function autoReflectStatus() {
  const last = DB.getSetting('last_reflect_at');
  const on = DB.getSetting('auto_reflect', 'true') === 'true';
  const next = last ? new Date(Date.parse(last) + 7 * 864e5).toISOString() : null;
  return { on, last, next, newEvidence: DB.evidenceStamp() !== DB.getSetting('last_reflect_stamp') };
}

// ---------- choose among saved books ----------
// "Which of these fits me right now?" for Up next / Someday / Maybe: ranks only books she already saved.
export async function chooseFromShelf(shelfId, { now = '' } = {}) {
  const shelf = DB.listShelves().find((s) => s.id === shelfId);
  if (!shelf) throw new Error('no such shelf');
  const items = DB.shelfItems(shelfId).slice(0, 15);
  if (items.length < 2) throw new Error('Save at least two books on this shelf first.');
  // Real review data for each book (cached; only missing or stale digests are written now).
  await Promise.all(items.map(async (it) => { const b = DB.getBook(it.book_id); if (b && DB.digestStale(b)) { try { await digestBook(b); } catch {} } }));
  const books = items.map((it) => {
    const b = DB.getBook(it.book_id); const d = b?.review_digest || {};
    return { book_id: it.book_id, title: b?.title, author: b?.author, pages: b?.pages, saved_note: it.note || '', saved_on: it.added_at?.slice(0, 10),
      one_line: d.one_line, appeal: d.appeal, romance: d.romance, series: d.series, first_100_pages: d.first_100_pages, complaints: (d.complaints || []).slice(0, 3), content_notes: d.content_notes,
      earlier_verdict: (() => { const v = DB.latestVerdict(it.book_id); return v ? { date: v.created_at.slice(0, 10), verdict: v.verdict.verdict, fit: v.verdict.fit, headline: v.verdict.headline, will_bother_you: v.verdict.will_bother_you } : undefined; })() };
  });
  const last = DB.listSessions(5).find((s) => !['onboarding', 'gift'].includes(s.mode));
  const recent = last && Date.now() - Date.parse(last.started_at) < 7 * 864e5 ? { date: last.started_at.slice(0, 10), answers: answersDigest(last.id).filter((a) => a.layer !== 'onboarding'), must_haves: last.brief?.must_haves || [] } : null;
  const reader = { reader_dna: readerDna(), traits: compactTraits(), mood_log: DB.moodLog(4), latest_checkin: recent, after_recent_books: debriefPatterns()?.sentences || undefined };
  const prompt = `READER (JSON):\n${JSON.stringify(reader, null, 1)}\n\nHOW SHE IS RIGHT NOW (her words, most important if given): ${now.trim() || '(not given; use the latest check-in and mood log, and say if they are old)'}\n\nSAVED BOOKS on "${shelf.name}" (JSON):\n${JSON.stringify(books, null, 1)}\n\nRank every saved book for right now.`;
  const { data } = await ask({ system: CHOOSE_SYSTEM, prompt, schema: CHOOSE_SCHEMA, tier: DB.getSetting('tier_verdict', 'best'), effort: 'medium' });
  const ids = new Set(books.map((b) => b.book_id));
  const seen = new Set();
  const order = data.order.filter((o) => ids.has(o.book_id) && !seen.has(o.book_id) && seen.add(o.book_id))
    .map((o) => ({ ...o, title: books.find((b) => b.book_id === o.book_id).title, author: books.find((b) => b.book_id === o.book_id).author }));
  for (const o of order) { const e = books.find((b) => b.book_id === o.book_id).earlier_verdict; if (e) o.earlier = { verdict: e.verdict, fit: e.fit, date: e.date }; }
  return { order, note: data.note, shelf: shelf.name, at: DB.now() };
}
