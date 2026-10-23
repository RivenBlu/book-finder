// Talking about books: conversation about one book or a slate, the "should I read this?" verdict,
// a Markdown export of a slate, and the weekly automatic Reader DNA rebuild.
import { ask } from '../llm.js';
import { chatSystem, VERDICT_SCHEMA, VERDICT_SYSTEM } from '../prompts.js';
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
export async function chat({ bookId, sessionId, message, onEvent }) {
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
  };
  const transcript = messages.slice(0, -1).slice(-16).map((m) => `${m.role === 'user' ? 'READER' : 'ADVISOR'}: ${m.text}`).join('\n\n');
  const prompt = `MATERIAL (JSON):\n${JSON.stringify(material, null, 1)}\n\n${transcript ? `CONVERSATION SO FAR:\n${transcript}\n\n` : ''}READER: ${message}\n\nReply as the advisor.`;
  const web = DB.getSetting('chat_web', 'true') === 'true';
  let reply;
  try {
    const { data } = await ask({ system: chatSystem({ scope }), prompt, tier: DB.getSetting('tier_chat', 'smart'), effort: 'medium', web, maxTurns: web ? 8 : 2, onEvent });
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
export async function verdictFor(bookId, { onEvent } = {}) {
  let book = DB.getBook(bookId);
  if (!book) throw new Error('no such book');
  if (!book.review_digest) { onEvent?.({ step: 'digest', msg: 'Reading the real reviews...' }); await digestBook(book); book = DB.getBook(bookId); }
  onEvent?.({ step: 'verdict', msg: 'Judging it against your profile...' });
  const ctx = fullContext(null);
  const last = DB.listSessions(5).find((s) => s.mode !== 'onboarding' && s.status !== 'closed');
  const recentCheckin = last && Date.now() - Date.parse(last.started_at) < 7 * 864e5 ? { date: last.started_at.slice(0, 10), answers: answersDigest(last.id).filter((a) => a.layer !== 'onboarding') } : null;
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
  picks.forEach((r, i) => {
    const f = r.fit;
    L.push(`## ${i + 1}. ${r.title}`, `${r.author}${r.year ? `, ${r.year}` : ''}${r.pages ? `, ${r.pages} pages` : ''} · ${(r.slot || '').replace(/_/g, ' ')}${r.rating ? ` · ★ ${Number(r.rating).toFixed(2)} from ${Number(r.ratings_count || 0).toLocaleString('en-GB')} ratings` : ''}`, '');
    L.push(`**${f.headline}**`, '', f.why_now, '');
    L.push(`- **Readers love:** ${f.what_readers_love}`, `- **Readers complain:** ${f.what_readers_complain}`, `- **Risk for you:** ${f.risk_for_you}`, `- **The opening:** ${f.first_pages}`, `- **Read if:** ${f.read_if}`, `- **Skip if:** ${f.skip_if}`);
    if (f.audio_note) L.push(`- **Audio:** ${f.audio_note}`);
    if (r.url) L.push(`- ${r.url}`);
    L.push('');
  });
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
