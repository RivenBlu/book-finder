// Local HTTP server: static UI + JSON API. Single user, binds to localhost only.
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as DB from './db.js';
import { ONBOARDING, CHECKIN } from './questions.js';
import { nextQuestion, recordAnswer, generateAdaptive, onboardingDone, undoLastAnswer } from './pipeline/interview.js';
import { runRecommendation, subscribe, progressOf, lookupBook, importGoodreadsBook, digestBook } from './pipeline/recommend.js';
import { reflectProfile, importHistoryCsv } from './pipeline/reflect.js';
import { MODELS, resolveModel } from './llm.js';
import { chat, loadChat, verdictFor, exportSlateMarkdown, maybeAutoReflect, autoReflectStatus } from './pipeline/talk.js';

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
  let s = ''; for await (const c of req) { s += c; if (s.length > 8_000_000) throw httpError(413, 'body too large'); }
  return s ? JSON.parse(s) : {};
}
// Same-origin guard: the API answers only this app's own pages. A page on another site that tries to call
// localhost (CSRF) carries a foreign Origin and is refused for anything that changes state.
const SELF_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`]);
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return SELF_ORIGINS.has(origin);
  const ref = req.headers.referer;
  if (ref) { try { return SELF_ORIGINS.has(new URL(ref).origin); } catch { return false; } }
  return true; // no Origin/Referer: a local tool like curl, not a browser page
}
function privateHost(hostname) {
  return /^(localhost|.*\.local|.*\.internal)$/i.test(hostname) || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) || /^\[?(::1|fe80:|fc|fd)/i.test(hostname);
}

// ---------- state ----------
route('GET', '/api/state', async () => ({
  onboardingDone: onboardingDone(),
  readerDna: DB.getFacts({ kind: 'trait' }).find((f) => f.key === 'reader_dna')?.value || null,
  shelves: DB.listShelves(),
  sessions: DB.listSessions(12),
  history: DB.historyStats(),
  settings: publicSettings(),
  verdicts: DB.recentVerdicts(6),
  autoReflect: autoReflectStatus(),
}));

// ---------- interview ----------
route('GET', '/api/questions', async () => ({ onboarding: ONBOARDING, checkin: CHECKIN }));
route('POST', '/api/sessions', async (req) => { const b = await body(req); const id = DB.createSession(b.mode || 'full'); return { id, ...DB.getSession(id) }; });
route('GET', '/api/sessions', async () => DB.listSessions(50));
route('GET', '/api/sessions/:id', async (req, p) => {
  const s = DB.getSession(Number(p.id)); if (!s) throw httpError(404, 'no such session');
  return { ...s, answers: DB.getAnswers(s.id), recommendations: DB.getRecommendations(s.id).map(withShelves), running: !!progressOf(s.id) };
});
route('DELETE', '/api/sessions/:id', async (req, p) => { DB.db.prepare('DELETE FROM sessions WHERE id = ?').run(Number(p.id)); return { ok: true }; });
route('GET', '/api/sessions/:id/next', async (req, p) => nextQuestion(Number(p.id)));
route('POST', '/api/sessions/:id/answer', async (req, p) => { const b = await body(req); recordAnswer(Number(p.id), b); return nextQuestion(Number(p.id)); });
route('POST', '/api/sessions/:id/back', async (req, p) => { undoLastAnswer(Number(p.id)); return nextQuestion(Number(p.id)); });
route('POST', '/api/sessions/:id/adaptive', async (req, p) => { const qs = await generateAdaptive(Number(p.id)); return { questions: qs, next: nextQuestion(Number(p.id)) }; });
route('POST', '/api/sessions/:id/recommend', async (req, p) => {
  const id = Number(p.id);
  if (progressOf(id)) return { started: false, running: true };
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
  try {
    await chat({ bookId: Number(b.bookId) || null, sessionId: Number(b.sessionId) || null, message: b.message.trim(), onEvent: send });
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
route('POST', '/api/profile/auto-reflect', async () => { const r = await maybeAutoReflect({ force: true }); return { ...r, status: autoReflectStatus() }; });

// ---------- recommendations feedback ----------
route('POST', '/api/recommendations/:id/feedback', async (req, p) => {
  const b = await body(req);
  DB.setRecommendationFeedback(Number(p.id), b.feedback, b.note || null);
  const rec = DB.db.prepare('SELECT book_id FROM recommendations WHERE id = ?').get(Number(p.id));
  if (b.shelf && rec) {
    const shelf = DB.listShelves().find((s) => s.name === b.shelf || s.id === b.shelf);
    if (shelf) DB.addToShelf({ shelfId: shelf.id, bookId: rec.book_id, note: b.note || null, exclusiveStatus: shelf.kind === 'system' });
  }
  if (b.feedback === 'not_for_me' && b.note) {
    DB.setFact({ key: 'rejected_' + rec.book_id, value: { note: b.note }, kind: 'trait', confidence: 0.6, source: 'feedback', note: 'Rejected recommendation' });
  }
  return { ok: true, shelves: rec ? DB.shelvesForBook(rec.book_id) : [] };
});

// ---------- shelves ----------
route('GET', '/api/shelves', async () => DB.listShelves());
route('POST', '/api/shelves', async (req) => { const b = await body(req); return { id: DB.createShelf(b.name, b.description || null) }; });
route('DELETE', '/api/shelves/:id', async (req, p) => { DB.deleteShelf(Number(p.id)); return { ok: true }; });
route('GET', '/api/shelves/:id/items', async (req, p) => DB.shelfItems(Number(p.id)));
route('POST', '/api/shelves/:id/items', async (req, p) => {
  const b = await body(req);
  const shelf = DB.listShelves().find((s) => s.id === Number(p.id));
  DB.addToShelf({ shelfId: Number(p.id), bookId: b.bookId, note: b.note || null, exclusiveStatus: shelf?.kind === 'system' });
  return { ok: true, shelves: DB.shelvesForBook(b.bookId) };
});
route('PATCH', '/api/shelf-items/:id', async (req, p) => { const b = await body(req); DB.updateShelfItem(Number(p.id), b); return { ok: true }; });
route('DELETE', '/api/shelf-items/:id', async (req, p) => { DB.removeFromShelf(Number(p.id)); return { ok: true }; });

// ---------- cover proxy (Amazon's image host stalls hotlinked requests; cache to disk) ----------
const COVERS = join(DB.DATA_DIR, 'covers');
mkdirSync(COVERS, { recursive: true });
route('GET', '/api/cover', async (req, p, res) => {
  const u = new URL(req.url, 'http://x').searchParams.get('u') || '';
  let host = ''; try { host = new URL(u).hostname; } catch {}
  if (!/^https:\/\/[\w.-]+\/.+/.test(u) || !host || privateHost(host)) { res.writeHead(400); res.end(); return null; }
  const file = join(COVERS, createHash('sha1').update(u).digest('hex') + '.jpg');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(data); return null;
  } catch {}
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) book-finder-personal/0.1', Accept: 'image/*' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    if (privateHost(new URL(r.url).hostname)) throw new Error('redirected to a private host');
    if (!/^image\//i.test(r.headers.get('content-type') || '')) throw new Error('not an image');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 500) throw new Error('empty');
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
route('POST', '/api/books/import', async (req) => { const b = await body(req); const book = await importGoodreadsBook(String(b.goodreadsId)); return withShelves(book); });
route('GET', '/api/books/:id', async (req, p) => { const b = DB.getBook(Number(p.id)); if (!b) throw httpError(404, 'no such book'); return withShelves(b); });
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
route('POST', '/api/settings', async (req) => { const b = await body(req); for (const [k, v] of Object.entries(b)) DB.setSetting(k, String(v)); return publicSettings(); });
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
  };
}

function withShelves(b) { return { ...b, shelves: DB.shelvesForBook(b.book_id || b.id) }; }
function httpError(status, message) { const e = new Error(message || 'error'); e.status = status; return e; }

// ---------- server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
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
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Book Finder running at http://localhost:${PORT}`);
  // Weekly Reader DNA rebuild: checked shortly after start and every few hours while the app runs.
  const tick = () => maybeAutoReflect().then((r) => { if (r.ran) console.log('[auto-reflect] done'); }).catch((e) => console.error('[auto-reflect]', e.message));
  setTimeout(tick, 45_000);
  setInterval(tick, 6 * 3600_000);
  if (process.argv.includes('--open')) import('node:child_process').then(({ exec }) => exec(`start "" "http://localhost:${PORT}"`));
});
