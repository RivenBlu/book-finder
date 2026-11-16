// Local HTTP server: static UI + JSON API. Single user, binds to localhost only.
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as DB from './db.js';
import { ONBOARDING, CHECKIN } from './questions.js';
import { nextQuestion, recordAnswer, generateAdaptive, generateAnchors, onboardingDone, undoLastAnswer } from './pipeline/interview.js';
import { runRecommendation, subscribe, progressOf, isRunning, lookupBook, importGoodreadsBook, digestBook, lookupPolish, keepBook, keptBooks, nudgeSlate, addBookToSlate, researchedCount } from './pipeline/recommend.js';
import { followups, recordOutcome, sayVsDo, fingerprint, reportStats, writeReport, enrichHistory, historyJob, authorNext, debriefPlan, recordDebrief, debriefFollowup, debriefPatterns, trainerList, trainerAnswer, listTrainer } from './pipeline/insights.js';
import { backupDatabase, listBackups, checkHealth, health, exportAll, importAll, lanStatus, setLan, lanToken } from './ops.js';
import { reflectProfile, importHistoryCsv } from './pipeline/reflect.js';
import { MODELS, resolveModel } from './llm.js';
import { chat, loadChat, verdictFor, exportSlateMarkdown, maybeAutoReflect, autoReflectStatus, chooseFromShelf } from './pipeline/talk.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 3737);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
async function body(req) {
  // Only JSON bodies are accepted: a form or text/plain POST from a web page is refused before parsing.
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw httpError(415, 'JSON body required');
  // Collect raw bytes and decode once: decoding chunk by chunk breaks Polish letters split across chunks.
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 8_000_000) throw httpError(413, 'body too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  let v; try { v = JSON.parse(s); } catch { throw httpError(400, 'invalid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw httpError(400, 'JSON object required');
  return v;
}
// Same-origin guard: the API answers only this app's own pages. A page on another site that tries to call
// localhost (CSRF) carries a foreign Origin and is refused for anything that changes state.
// The Host header is checked against a fixed list (never trusted as-is): otherwise a site whose DNS name is
// re-pointed at 127.0.0.1 ("DNS rebinding") would look same-origin and could read the API.
function allowedHosts() {
  const names = ['localhost', '127.0.0.1', '[::1]'];
  if (LAN) names.push(...lanStatus().ips, hostname().toLowerCase(), `${hostname().toLowerCase()}.local`);
  return new Set(names.flatMap((n) => (PORT === 80 ? [n, `${n}:80`] : [`${n}:${PORT}`])));
}
function hostAllowed(req) { return allowedHosts().has((req.headers.host || '').toLowerCase()); }
function selfOrigins() { return new Set([...allowedHosts()].map((h) => `http://${h}`)); }
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return selfOrigins().has(origin);
  const ref = req.headers.referer;
  if (ref) { try { return selfOrigins().has(new URL(ref).origin); } catch { return false; } }
  // Browsers mark requests from other sites even when Origin and Referer are absent (e.g. an <img> tag).
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true; // no Origin/Referer: a local tool like curl, not a browser page
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
// Home-network mode: requests that do not come from this machine must carry the token cookie.
function isLoopback(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function lanAuthorised(req) {
  if (isLoopback(req)) return true;
  const token = lanToken(); if (!token) return false;
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('bf_token='));
  return !!cookie && safeEqual(cookie.slice(9), token);
}
function privateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  return /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(h) || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || /^(::|::1|fe80:|fc|fd|::ffff:)/i.test(h);
}
// A public-looking name can still resolve to a private address; check what it actually resolves to.
async function resolvesPrivate(hostname) {
  if (privateHost(hostname)) return true;
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return false;
  try { const addrs = await lookup(hostname, { all: true }); return !addrs.length || addrs.some((a) => privateHost(a.address)); }
  catch { return true; }
}

// ---------- state ----------
route('GET', '/api/state', async () => (DB.pruneEmptySessions(10), {
  onboardingDone: onboardingDone(),
  readerDna: DB.getFacts({ kind: 'trait' }).find((f) => f.key === 'reader_dna')?.value || null,
  tasteConfirmedAt: DB.getFacts({ kind: 'trait' }).filter((f) => f.source === 'answer' && !/_completed$/.test(f.key)).map((f) => f.observed_at).sort().pop() || null,
  shelves: DB.listShelves(),
  sessions: DB.listSessions(12),
  history: DB.historyStats(),
  settings: publicSettings(),
  verdicts: DB.recentVerdicts(6),
  autoReflect: autoReflectStatus(),
  followups: followups().length,
  reading: DB.readingNow(),
  upNext: upNext(),
  health: { checkedAt: health.checkedAt, problems: health.problems },
  lan: lanStatus(),
}));

// ---------- interview ----------
route('GET', '/api/questions', async () => ({ onboarding: ONBOARDING, checkin: CHECKIN }));
route('POST', '/api/sessions', async (req) => { const b = await body(req); DB.pruneEmptySessions(2); const id = DB.createSession(b.mode || 'full'); return { id, ...DB.getSession(id) }; });
route('GET', '/api/sessions', async () => DB.listSessions(50));
route('GET', '/api/sessions/:id', async (req, p) => {
  const s = DB.getSession(Number(p.id)); if (!s) throw httpError(404, 'no such session');
  // The highest fit any book has ever been given: lets the page say "your highest so far" beside a number that looks modest.
  const best = DB.db.prepare("SELECT MAX(CAST(json_extract(verdict, '$.fit') AS INTEGER)) AS m FROM verdicts").get()?.m ?? null;
  return { ...s, answers: DB.getAnswers(s.id), recommendations: DB.getRecommendations(s.id).map(withShelves), running: isRunning(s.id), best_fit_ever: best };
});
route('DELETE', '/api/sessions/:id', async (req, p) => { DB.db.prepare('DELETE FROM sessions WHERE id = ?').run(Number(p.id)); return { ok: true }; });
route('GET', '/api/sessions/:id/next', async (req, p) => nextQuestion(Number(p.id)));
route('POST', '/api/sessions/:id/answer', async (req, p) => { const b = await body(req); recordAnswer(Number(p.id), b); return nextQuestion(Number(p.id)); });
route('POST', '/api/sessions/:id/back', async (req, p) => { undoLastAnswer(Number(p.id)); return nextQuestion(Number(p.id)); });
route('POST', '/api/sessions/:id/adaptive', async (req, p) => { const qs = await generateAdaptive(Number(p.id)); return { questions: qs, next: nextQuestion(Number(p.id)) }; });
route('POST', '/api/sessions/:id/anchors', async (req, p) => { const qs = await generateAnchors(Number(p.id)); return { questions: qs, next: nextQuestion(Number(p.id)) }; });
route('POST', '/api/sessions/:id/recommend', async (req, p) => {
  const id = Number(p.id);
  if (!DB.getSession(id)) throw httpError(404, 'no such session');
  if (isRunning(id)) return { started: false, running: true };
  const b = await body(req).catch(() => ({}));
  runRecommendation(id, { instant: !!b.instant }).catch((e) => console.error('[recommend]', e));
  return { started: true };
});
// How many researched books a fast pick could choose from.
route('GET', '/api/researched', async () => ({ count: researchedCount() }));
// Taste trainer: a set of well-known books to react to, and her answers (stored as reading history, source "trainer").
route('POST', '/api/trainer/list', async () => ({ books: await trainerList(18), answered: listTrainer().length }));
route('GET', '/api/trainer', async () => ({ answered: listTrainer().length }));
route('POST', '/api/trainer/answer', async (req) => { const b = await body(req); return trainerAnswer({ title: String(b.title || '').slice(0, 300), author: String(b.author || '').slice(0, 200), verdict: b.verdict, as: b.as || null }); });
// While the research runs: keep a candidate on the final list whatever the ranking says (or let it go again).
route('POST', '/api/sessions/:id/keep', async (req, p) => { const b = await body(req); return { kept: keepBook(Number(p.id), Number(b.bookId), b.keep !== false) }; });
route('GET', '/api/sessions/:id/kept', async (req, p) => ({ kept: keptBooks(Number(p.id)) }));
// After the list: adjust it in her words without new research; add a set-aside book anyway.
route('POST', '/api/sessions/:id/nudge', async (req, p) => { const b = await body(req); const t = String(b.text || '').trim().slice(0, 400); if (!t) throw httpError(400, 'Say what to change.'); return await nudgeSlate(Number(p.id), t); });
route('POST', '/api/sessions/:id/add-book', async (req, p) => { const b = await body(req); return await addBookToSlate(Number(p.id), Number(b.bookId)); });
// Nothing had every must-have: she names a book that has it (a reference point), relaxes one, or both, and the search runs again.
route('POST', '/api/sessions/:id/retry-musts', async (req, p) => {
  const id = Number(p.id); const b = await body(req);
  if (!DB.getSession(id)) throw httpError(404, 'no such session');
  if (isRunning(id)) return { started: false, running: true };
  const example = String(b.example || '').trim().slice(0, 300);
  const relax = (Array.isArray(b.relax) ? b.relax : []).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 8);
  if (!example && !relax.length) throw httpError(400, 'Name a book, or choose a must-have to relax.');
  if (example) DB.addAnswer({ sessionId: id, qId: 'must_example', layer: 'checkin', question: 'A book that, for the reader, HAS everything she listed as must-haves (her reference point for what they mean)', options: null, answer: null, freeText: example });
  if (relax.length) DB.addAnswer({ sessionId: id, qId: 'must_relax', layer: 'checkin', question: 'Must-haves the reader agreed to relax into strong wishes after nothing matched', options: null, answer: null, freeText: relax.join('; ') });
  runRecommendation(id).catch((e) => console.error('[recommend]', e));
  return { started: true };
});
route('GET', '/api/sessions/:id/events', async (req, p, res) => {
  const id = Number(p.id);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const r = progressOf(id);
  if (!r) { send({ step: 'idle', msg: 'not running' }); res.end(); return null; }
  for (const ev of r.log) send(ev);
  if (r.failed) { res.end(); return null; }
  const off = subscribe(id, (ev) => { send(ev); if (ev.step === 'done' || ev.step === 'error') { off(); res.end(); } });
  req.on('close', off);
  return null;
});

// ---------- talk: chat about a book or a slate (streamed), verdicts, export ----------
route('GET', '/api/chat', async (req) => {
  const u = new URL(req.url, 'http://x');
  return loadChat({ bookId: Number(u.searchParams.get('bookId')) || null, sessionId: Number(u.searchParams.get('sessionId')) || null }) || { messages: [] };
});
route('POST', '/api/chat', async (req, p, res) => {
  const b = await body(req);
  if (!b.message?.trim()) throw httpError(400, 'empty message');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} };
  // Leaving the page stops the answer instead of letting it run on the subscription for nobody.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    await chat({ bookId: Number(b.bookId) || null, sessionId: Number(b.sessionId) || null, message: b.message.trim(), page: Number(b.page) || null, onEvent: send, abortController: ac });
  } catch (e) { send({ type: 'error', message: e.message }); }
  res.end();
  return null;
});
route('DELETE', '/api/chat/:id', async (req, p) => { DB.clearChat(Number(p.id)); return { ok: true }; });
route('GET', '/api/books/:id/verdict', async (req, p) => DB.latestVerdict(Number(p.id)) || { verdict: null });
route('POST', '/api/books/:id/verdict', async (req, p) => ({ verdict: await verdictFor(Number(p.id)), created_at: DB.now() }));
route('GET', '/api/sessions/:id/export', async (req, p, res) => {
  const md = exportSlateMarkdown(Number(p.id));
  const dl = new URL(req.url, 'http://x').searchParams.get('download');
  res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', ...(dl ? { 'content-disposition': `attachment; filename="books-${p.id}.md"` } : {}) });
  res.end(md);
  return null;
});
route('GET', '/api/moods', async () => DB.moodLog(60));

// ---------- learning: loop closer, evidence, reports, history enrichment, author next, notes ----------
route('GET', '/api/followups', async (req) => followups(Number(new URL(req.url, 'http://x').searchParams.get('exclude')) || null));
route('POST', '/api/recommendations/:id/outcome', async (req, p) => { const b = await body(req); return recordOutcome(Number(p.id), b); });
route('GET', '/api/insights', async () => ({ sayVsDo: sayVsDo(), fingerprint: fingerprint(), afterReading: debriefPatterns() }));
// Past picks: every slate with what became of each book.
route('GET', '/api/past', async () => DB.listSessionsWithPicks(100));
// After-reading debrief: the plan (questions for this book), the save, and the one LLM-written follow-up question.
route('GET', '/api/debrief/plan', async (req) => {
  const u = new URL(req.url, 'http://x');
  return debriefPlan({ bookId: Number(u.searchParams.get('bookId')), recId: Number(u.searchParams.get('rec')) || null, outcome: u.searchParams.get('outcome') || 'finished' });
});
route('POST', '/api/debrief/followup', async (req) => { const b = await body(req); return await debriefFollowup({ bookId: Number(b.bookId), recId: Number(b.recId) || null, outcome: b.outcome, answers: b.answers || {}, text: b.text || null, rating: Number(b.rating) || null, page: Number(b.page) || null }); });
route('POST', '/api/debriefs', async (req) => {
  const b = await body(req);
  return recordDebrief({ bookId: Number(b.bookId), recId: Number(b.recId) || null, outcome: b.outcome, rating: Number(b.rating) || null, page: Number(b.page) || null, reason: b.reason || null, answers: b.answers || {}, text: b.text || null });
});
route('GET', '/api/debriefs', async (req) => DB.listDebriefs({ bookId: Number(new URL(req.url, 'http://x').searchParams.get('bookId')) || null, limit: 100 }));
route('DELETE', '/api/debriefs/:id', async (req, p) => { DB.db.prepare('DELETE FROM debriefs WHERE id = ?').run(Number(p.id)); return { ok: true }; });
route('GET', '/api/report', async (req) => reportStats(new URL(req.url, 'http://x').searchParams.get('period') || 'quarter'));
route('POST', '/api/report', async (req) => { const b = await body(req); return await writeReport(b.period || 'quarter'); });
route('GET', '/api/history/enrich', async () => historyJob);
route('POST', '/api/history/enrich', async (req) => { const b = await body(req); return await enrichHistory({ limit: Number(b.limit) || 20 }); });
route('POST', '/api/books/:id/author-next', async (req, p) => { const b = await body(req); return await authorNext(Number(p.id), { force: !!b.force }); });
route('POST', '/api/books/:id/polish', async (req, p) => ({ polish: await lookupPolish(Number(p.id)) }));
route('GET', '/api/notes', async (req) => DB.listNotes({ bookId: Number(new URL(req.url, 'http://x').searchParams.get('bookId')) || null }));
route('POST', '/api/notes', async (req) => { const b = await body(req); if (!b.text?.trim()) throw httpError(400, 'empty'); return { id: DB.addNote({ bookId: Number(b.bookId) || null, text: b.text.trim(), page: Number(b.page) || null, kind: b.kind || 'quote' }) }; });
route('DELETE', '/api/notes/:id', async (req, p) => { DB.deleteNote(Number(p.id)); return { ok: true }; });

// ---------- operations: backups, health, export/import, home network ----------
route('GET', '/api/ops', async () => ({ backups: listBackups(), health, lan: lanStatus() }));
route('POST', '/api/ops/backup', async () => backupDatabase());
route('POST', '/api/ops/health', async () => await checkHealth());
route('GET', '/api/ops/export', async (req, p, res) => {
  const data = exportAll();
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="book-finder-export-${new Date().toISOString().slice(0, 10)}.json"` });
  res.end(JSON.stringify(data)); return null;
});
route('POST', '/api/ops/import', async (req) => { const b = await body(req); return { imported: importAll(b.data, { replace: !!b.replace }) }; });
route('POST', '/api/ops/lan', async (req) => { const b = await body(req); const st = setLan(!!b.enabled); return { ...st, restart: true, url: st.enabled && st.ips[0] ? `http://${st.ips[0]}:${PORT}/login?t=${lanToken()}` : null }; });
route('GET', '/api/ops/lan-url', async () => { const st = lanStatus(); return { url: st.enabled && st.ips[0] ? `http://${st.ips[0]}:${PORT}/login?t=${lanToken()}` : null }; });
route('POST', '/api/profile/auto-reflect', async () => { const r = await maybeAutoReflect({ force: true }); return { ...r, status: autoReflectStatus() }; });

// ---------- recommendations feedback ----------
route('POST', '/api/recommendations/:id/feedback', async (req, p) => {
  const b = await body(req);
  const rec = DB.db.prepare('SELECT book_id FROM recommendations WHERE id = ?').get(Number(p.id));
  if (!rec) throw httpError(404, 'no such recommendation');
  DB.setRecommendationFeedback(Number(p.id), b.feedback, b.note || null);
  if (b.shelf) {
    const shelf = DB.listShelves().find((s) => s.name === b.shelf || s.id === b.shelf);
    if (shelf) DB.addToShelf({ shelfId: shelf.id, bookId: rec.book_id, note: b.note || null, exclusiveStatus: DB.isStatusShelf(shelf) });
  }
  if (b.feedback === 'not_for_me' && b.note) {
    DB.setFact({ key: 'rejected_' + rec.book_id, value: { note: b.note }, kind: 'trait', confidence: 0.6, source: 'feedback', note: 'Rejected recommendation' });
  }
  return { ok: true, shelves: DB.shelvesForBook(rec.book_id) };
});

// Where the book is kept (Up next, Maybe, off the list, or nowhere). Pressing the same answer again sends null.
route('POST', '/api/recommendations/:id/place', async (req, p) => {
  const b = await body(req);
  if (![null, 'up_next', 'maybe', 'removed'].includes(b.place ?? null)) throw httpError(400, 'unknown place');
  const row = DB.placeRecommendation(Number(p.id), b.place ?? null);
  if (!row) throw httpError(404, 'no such recommendation');
  return row;
});
// Her take on the suggestion (love, hate, or null to take it back). A taste signal only: the book is not moved.
route('POST', '/api/recommendations/:id/reaction', async (req, p) => {
  const b = await body(req);
  if (![null, 'love', 'hate'].includes(b.reaction ?? null)) throw httpError(400, 'unknown reaction');
  const rec = DB.db.prepare('SELECT book_id FROM recommendations WHERE id = ?').get(Number(p.id));
  if (!rec) throw httpError(404, 'no such recommendation');
  DB.setRecommendationReaction(Number(p.id), b.reaction ?? null, String(b.note || '').trim() || null);
  if (b.reaction === 'hate' && b.note) DB.setFact({ key: 'rejected_' + rec.book_id, value: { note: String(b.note).trim() }, kind: 'trait', confidence: 0.7, source: 'feedback', note: 'Called a bad suggestion' });
  else DB.db.prepare("UPDATE profile_facts SET active = 0 WHERE key = ? AND note = 'Called a bad suggestion'").run('rejected_' + rec.book_id);
  return DB.db.prepare('SELECT id, book_id, feedback, feedback_note, reaction, reaction_note FROM recommendations WHERE id = ?').get(Number(p.id));
});

// ---------- shelves ----------
route('GET', '/api/shelves', async () => DB.listShelves());
route('POST', '/api/shelves', async (req) => { const b = await body(req); return { id: DB.createShelf(b.name, b.description || null) }; });
route('DELETE', '/api/shelves/:id', async (req, p) => { DB.deleteShelf(Number(p.id)); return { ok: true }; });
route('GET', '/api/shelves/:id/items', async (req, p) => DB.shelfItems(Number(p.id)));
route('POST', '/api/shelves/:id/items', async (req, p) => {
  const b = await body(req);
  const shelf = DB.listShelves().find((s) => s.id === Number(p.id));
  if (!shelf) throw httpError(404, 'no such shelf');
  DB.addToShelf({ shelfId: Number(p.id), bookId: b.bookId, note: b.note || null, exclusiveStatus: DB.isStatusShelf(shelf) });
  return { ok: true, shelves: DB.shelvesForBook(b.bookId) };
});
route('POST', '/api/shelves/:id/choose', async (req, p) => { const b = await body(req); return await chooseFromShelf(Number(p.id), { now: String(b.now || '').slice(0, 500) }); });
route('PATCH', '/api/shelf-items/:id', async (req, p) => { const b = await body(req); DB.updateShelfItem(Number(p.id), b); return { ok: true }; });
route('DELETE', '/api/shelf-items/:id', async (req, p) => { DB.removeFromShelf(Number(p.id)); return { ok: true }; });

// ---------- cover proxy (Amazon's image host stalls hotlinked requests; cache to disk) ----------
const COVERS = join(DB.DATA_DIR, 'covers');
mkdirSync(COVERS, { recursive: true });
route('GET', '/api/cover', async (req, p, res) => {
  const u = new URL(req.url, 'http://x').searchParams.get('u') || '';
  let host = ''; try { host = new URL(u).hostname; } catch {}
  if (!/^https:\/\/[\w.-]+\/.+/.test(u) || !host || privateHost(host)) { res.writeHead(400); res.end(); return null; }
  // Only this app's own pages may use the proxy (browsers send Sec-Fetch-Site on image requests).
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') { res.writeHead(403); res.end(); return null; }
  const file = join(COVERS, createHash('sha1').update(u).digest('hex') + '.jpg');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(data); return null;
  } catch {}
  try {
    // Follow redirects by hand so that every hop, not only the last one, is checked for a private address.
    let target = u, r = null;
    for (let hop = 0; hop < 4; hop++) {
      const t = new URL(target);
      if (t.protocol !== 'https:' || await resolvesPrivate(t.hostname)) throw new Error('private or non-https host');
      r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) book-finder-personal/0.1', Accept: 'image/*' }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { target = new URL(r.headers.get('location'), target).href; continue; }
      break;
    }
    if (!r?.ok) throw new Error(String(r?.status));
    if (!/^image\//i.test(r.headers.get('content-type') || '')) throw new Error('not an image');
    if (Number(r.headers.get('content-length') || 0) > 5_000_000) throw new Error('too large');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 500 || buf.length > 5_000_000) throw new Error('empty or too large');
    await writeFile(file, buf);
    res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'cache-control': 'no-store' }); res.end();
  }
  return null;
});

// ---------- books ----------
route('GET', '/api/books/search', async (req) => lookupBook(new URL(req.url, 'http://x').searchParams.get('q') || ''));
route('POST', '/api/books/import', async (req) => {
  const b = await body(req);
  if (!/^\d{1,12}$/.test(String(b.goodreadsId || ''))) throw httpError(400, 'bad Goodreads id');
  return withShelves(await importGoodreadsBook(String(b.goodreadsId)));
});
route('GET', '/api/books/:id', async (req, p) => {
  const b = DB.getBook(Number(p.id)); if (!b) throw httpError(404, 'no such book');
  const rec = DB.db.prepare("SELECT id, session_id, feedback FROM recommendations r WHERE book_id = ? AND slot NOT IN ('runner_up', 'exception') ORDER BY id DESC LIMIT 1").get(b.id) || null;
  return { ...withShelves(b), progress: DB.shelfItemFor(b.id, 'Reading now')?.page || null, notes: DB.listNotes({ bookId: b.id }), debrief: DB.latestDebrief(b.id), rec };
});
route('POST', '/api/books/:id/digest', async (req, p) => { const b = DB.getBook(Number(p.id)); if (!b) throw httpError(404); return await digestBook(b); });

// ---------- history ----------
route('GET', '/api/history', async () => DB.listHistory({ limit: 2000 }));
route('POST', '/api/history/import', async (req) => { const b = await body(req); return importHistoryCsv(b.csv || ''); });
route('POST', '/api/history', async (req) => {
  const b = await body(req);
  DB.addHistory({ title: b.title, author: b.author || null, myRating: b.rating || null, myReview: b.review || null, dateRead: b.date || null, status: b.status || 'read', tags: [], source: 'manual', bookId: b.bookId || null });
  return { ok: true };
});
route('DELETE', '/api/history/:id', async (req, p) => { DB.deleteHistory(Number(p.id)); return { ok: true }; });

// ---------- profile ----------
route('GET', '/api/profile', async () => ({ facts: DB.getFacts({ kind: 'trait' }), states: DB.getFacts({ kind: 'state' }).slice(0, 60), questions: ONBOARDING }));
route('GET', '/api/profile/history/:key', async (req, p) => DB.factHistory(p.key));
route('POST', '/api/profile/fact', async (req) => { const b = await body(req); DB.setFact({ key: b.key, value: b.value, kind: b.kind || 'trait', confidence: b.confidence ?? 0.9, source: 'manual', note: b.note || null }); return { ok: true }; });
route('DELETE', '/api/profile/fact/:id', async (req, p) => { DB.deleteFact(Number(p.id)); return { ok: true }; });
route('POST', '/api/profile/reflect', async () => await reflectProfile());

// ---------- settings ----------
route('GET', '/api/settings', async () => publicSettings());
// Only these keys can be changed from the page; tokens for home-network mode and health data are managed by the server.
const EDITABLE_SETTINGS = /^(tier_(brief|candidates|digest|rank|adaptive|reflect|chat|verdict)|model_(fast|smart|best|max)|candidates_web|chat_web|auto_reflect|adaptive_count|hardcover_token|verify_picks|pinned_questions)$/;
route('POST', '/api/settings', async (req) => {
  const b = await body(req);
  for (const [k, v] of Object.entries(b)) if (EDITABLE_SETTINGS.test(k) && v !== null && typeof v !== 'object') DB.setSetting(k, String(v));
  return publicSettings();
});
function publicSettings() {
  const s = DB.allSettings();
  return {
    tiers: { brief: s.tier_brief || 'smart', candidates: s.tier_candidates || 'best', digest: s.tier_digest || 'fast', rank: s.tier_rank || 'best', adaptive: s.tier_adaptive || 'smart', reflect: s.tier_reflect || 'best', chat: s.tier_chat || 'smart', verdict: s.tier_verdict || 'best' },
    models: { fast: resolveModel('fast'), smart: resolveModel('smart'), best: resolveModel('best'), max: resolveModel('max') },
    defaults: MODELS,
    candidates_web: (s.candidates_web ?? 'true') === 'true',
    adaptive_count: Number(s.adaptive_count ?? 3),
    hardcover_token: s.hardcover_token ? '(set)' : '',
    chat_web: (s.chat_web ?? 'true') === 'true',
    auto_reflect: (s.auto_reflect ?? 'true') === 'true',
    verify_picks: (s.verify_picks ?? 'true') === 'true',
    pinned_questions: s.pinned_questions || '',
  };
}

// The Up next shelf for the home page: covers, with the latest fit number where the book has been judged.
function upNext() {
  const shelf = DB.listShelves().find((s) => s.name === 'Up next'); if (!shelf) return { id: null, items: [] };
  const items = DB.shelfItems(shelf.id).map((it) => { const v = DB.latestVerdict(it.book_id)?.verdict; return { book_id: it.book_id, title: it.title, author: it.author, cover: it.cover, fit: v?.fit ?? null, verdict: v?.verdict ?? null }; });
  items.sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1));
  return { id: shelf.id, items };
}
function withShelves(b) { return { ...b, shelves: DB.shelvesForBook(b.book_id || b.id) }; }
function httpError(status, message) { const e = new Error(message || 'error'); e.status = status; return e; }

// ---------- server ----------
const LAN = DB.getSetting('lan_enabled', 'false') === 'true' && !!lanToken();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  try {
    if (!hostAllowed(req)) { res.writeHead(421, { 'content-type': 'text/plain' }); res.end('Book Finder: unknown host name. Open http://localhost:' + PORT); return; }
    if (url.pathname === '/login') {
      const t = url.searchParams.get('t') || '';
      if (t && safeEqual(t, lanToken())) { res.writeHead(302, { 'set-cookie': `bf_token=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, location: '/' }); res.end(); return; }
      res.writeHead(403); res.end('wrong token'); return;
    }
    if (!lanAuthorised(req)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Book Finder: open the link with the token from Settings on this device first.'); return; }
    if (url.pathname.startsWith('/api/') && !sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const out = await r.fn(req, m.groups || {}, res);
      if (out !== null) json(res, 200, out);
      return;
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // static
    let file = join(WEB, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
    try { await stat(file); } catch { file = join(WEB, 'index.html'); }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch (e) {
    console.error(req.method, url.pathname, e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Book Finder running at http://localhost:${PORT}${LAN ? ' (home-network mode on; token required from other devices)' : ''}`);
  const backup = () => { try { const b = backupDatabase(); if (b) console.log('[backup]', b.file); } catch (e) { console.error('[backup]', e.message); } };
  backup();
  setInterval(backup, 3 * 3600_000); // a new daily copy even when the app stays open for days
  setTimeout(() => checkHealth().then((h) => { if (h.problems.length) console.warn('[health]', h.problems.join(' | ')); }).catch(() => {}), 10_000);
  // Weekly Reader DNA rebuild: checked shortly after start and every few hours while the app runs.
  const tick = () => maybeAutoReflect().then((r) => { if (r.ran) console.log('[auto-reflect] done'); }).catch((e) => console.error('[auto-reflect]', e.message));
  setTimeout(tick, 45_000);
  setInterval(tick, 6 * 3600_000);
  // Close the database cleanly on Ctrl+C or when the window is closed.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { try { DB.db.close(); } catch {} process.exit(0); });
  if (process.argv.includes('--open')) import('node:child_process').then(({ exec }) => exec(`start "" "http://localhost:${PORT}"`));
});
