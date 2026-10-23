// SQLite storage via Node's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(process.env.BOOKFINDER_DB || join(DATA_DIR, 'bookfinder.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

-- Everything we know about the reader. kind: trait (stable), state (today), history (facts about books read).
-- Facts are never overwritten: a new row supersedes the old one (active=0). This keeps drift visible.
CREATE TABLE IF NOT EXISTS profile_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,            -- JSON
  kind TEXT NOT NULL,             -- trait | state | history
  confidence REAL DEFAULT 0.7,
  source TEXT,                    -- answer | inferred | import | feedback | manual
  note TEXT,
  session_id INTEGER,
  observed_at TEXT NOT NULL,
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_facts_key ON profile_facts(key, active);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'interview',   -- interview | researching | recommended | closed
  mode TEXT NOT NULL DEFAULT 'full',          -- full | quick | onboarding
  summary TEXT,                               -- LLM one-paragraph reading of the person right now
  brief TEXT,                                 -- JSON: the recommendation brief built from answers
  progress TEXT,                              -- JSON: live progress log for the research step
  adaptive TEXT,                              -- JSON: LLM-generated follow-up questions
  adaptive_reasoning TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  q_id TEXT NOT NULL,
  layer TEXT NOT NULL,            -- onboarding | checkin | adaptive | followup
  question TEXT NOT NULL,
  options TEXT,                   -- JSON array
  answer TEXT,                    -- JSON (selected option ids / values)
  free_text TEXT,
  skipped INTEGER DEFAULT 0,
  asked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goodreads_id TEXT UNIQUE,
  ol_key TEXT,
  title TEXT NOT NULL,
  author TEXT,
  year INTEGER,
  pages INTEGER,
  language TEXT,
  genres TEXT,                    -- JSON
  description TEXT,
  cover TEXT,
  url TEXT,
  rating REAL,
  ratings_count INTEGER,
  rating_dist TEXT,               -- JSON [1..5 star counts]
  reviews TEXT,                   -- JSON array of real reviews
  review_digest TEXT,             -- JSON: LLM digest (praise, complaints, who loves/hates, content notes)
  extra TEXT,                     -- JSON: awards, series, subjects...
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title, author);

CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id),
  rank INTEGER,
  slot TEXT,                      -- safe_bet | stretch | wildcard | comfort | ...
  fit TEXT,                       -- JSON: why_now, what_readers_love, what_readers_complain, risk_for_you, read_if, skip_if, confidence
  feedback TEXT,                  -- null | saved | not_now | not_for_me | already_read | started
  feedback_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shelves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',   -- system | custom
  description TEXT,
  sort INTEGER DEFAULT 100,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shelf_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shelf_id INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id),
  note TEXT,                      -- why saved / for which mood
  my_rating INTEGER,              -- 1..5 once read
  my_verdict TEXT,                -- JSON: {loved:[], disliked:[], dnf_reason, would_reread}
  added_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(shelf_id, book_id)
);

-- Reading history (imports + manual). Separate from shelves so imports never pollute curated lists.
CREATE TABLE IF NOT EXISTS reading_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER REFERENCES books(id),
  title TEXT NOT NULL,
  author TEXT,
  my_rating INTEGER,
  my_review TEXT,
  date_read TEXT,
  status TEXT,                    -- read | dnf | to-read | currently-reading
  tags TEXT,                      -- JSON (shelves/tags from source)
  source TEXT NOT NULL,           -- goodreads_csv | storygraph_csv | manual | interview
  raw TEXT,                       -- JSON original row
  imported_at TEXT NOT NULL,
  UNIQUE(title, author, source)
);

-- Conversations about one book (or about a whole slate when book_id is null), kept per session.
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER REFERENCES books(id),
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  messages TEXT NOT NULL,         -- JSON [{role, text, at}]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats ON chats(book_id, session_id);

-- "Should I read this?" verdicts on a specific book, against the profile at that time.
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  verdict TEXT NOT NULL,          -- JSON
  created_at TEXT NOT NULL
);
`);

const SYSTEM_SHELVES = [
  ['Reading now', 'What I am reading at the moment', 1],
  ['Up next', 'Chosen, waiting for me', 2],
  ['Someday', 'Liked the recommendation, not for this moment', 3],
  ['Maybe', 'Intrigued but unsure', 4],
  ['Finished', 'Read it (rate it and tell the tool what you thought)', 5],
  ['Did not finish', 'Abandoned, with the reason', 6],
  ['Not for me', 'Rejected; the tool will stop suggesting these and learn from why', 7],
];
for (const [name, description, sort] of SYSTEM_SHELVES) {
  db.prepare('INSERT OR IGNORE INTO shelves(name, kind, description, sort, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, 'system', description, sort, now());
}

export function now() { return new Date().toISOString(); }
const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return s; } };

// ---------- settings ----------
export function getSetting(key, fallback = null) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value ?? '');
}
export function allSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

// ---------- profile facts ----------
export function setFact({ key, value, kind = 'trait', confidence = 0.8, source = 'answer', note = null, sessionId = null }) {
  db.prepare('UPDATE profile_facts SET active = 0 WHERE key = ? AND active = 1').run(key);
  db.prepare(`INSERT INTO profile_facts(key, value, kind, confidence, source, note, session_id, observed_at, active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(key, J(value), kind, confidence, source, note, sessionId, now());
}
export function getFacts({ kind = null, includeInactive = false } = {}) {
  let sql = 'SELECT * FROM profile_facts WHERE 1=1';
  const args = [];
  if (!includeInactive) sql += ' AND active = 1';
  if (kind) { sql += ' AND kind = ?'; args.push(kind); }
  sql += ' ORDER BY observed_at DESC';
  return db.prepare(sql).all(...args).map((r) => ({ ...r, value: P(r.value) }));
}
export function factHistory(key) {
  return db.prepare('SELECT * FROM profile_facts WHERE key = ? ORDER BY observed_at DESC').all(key).map((r) => ({ ...r, value: P(r.value) }));
}
export function deleteFact(id) { db.prepare('DELETE FROM profile_facts WHERE id = ?').run(id); }

// ---------- sessions & answers ----------
export function createSession(mode = 'full') {
  const r = db.prepare('INSERT INTO sessions(started_at, status, mode) VALUES (?, ?, ?)').run(now(), 'interview', mode);
  return Number(r.lastInsertRowid);
}
export function getSession(id) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s) return null;
  return { ...s, brief: P(s.brief), progress: P(s.progress), adaptive: P(s.adaptive) };
}
export function updateSession(id, patch) {
  const cols = []; const args = [];
  for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); args.push(typeof v === 'object' && v !== null ? J(v) : v); }
  args.push(id);
  db.prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...args);
}
export function listSessions(limit = 30) {
  return db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT ?').all(limit).map((s) => ({ ...s, brief: P(s.brief), progress: undefined }));
}
export function addAnswer({ sessionId, qId, layer, question, options, answer, freeText = null, skipped = false }) {
  db.prepare(`INSERT INTO answers(session_id, q_id, layer, question, options, answer, free_text, skipped, asked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, qId, layer, question, J(options), J(answer), freeText, skipped ? 1 : 0, now());
}
export function getAnswers(sessionId) {
  return db.prepare('SELECT * FROM answers WHERE session_id = ? ORDER BY id').all(sessionId)
    .map((a) => ({ ...a, options: P(a.options), answer: P(a.answer) }));
}
export function recentAnswers(qId, limit = 5) {
  return db.prepare('SELECT a.*, s.started_at FROM answers a JOIN sessions s ON s.id = a.session_id WHERE a.q_id = ? AND a.skipped = 0 ORDER BY a.id DESC LIMIT ?')
    .all(qId, limit).map((a) => ({ ...a, options: P(a.options), answer: P(a.answer) }));
}

// ---------- books ----------
export function upsertBook(b) {
  const existing = b.goodreadsId ? db.prepare('SELECT id FROM books WHERE goodreads_id = ?').get(String(b.goodreadsId)) : null;
  const row = {
    goodreads_id: b.goodreadsId ? String(b.goodreadsId) : null, ol_key: b.olKey || null, title: b.title, author: b.author || null,
    year: b.originalYear || b.year || null, pages: b.pages || null, language: b.language || null, genres: J(b.genres || []),
    description: b.description || null, cover: b.cover || null, url: b.url || null, rating: b.rating ?? null,
    ratings_count: b.ratingsCount ?? null, rating_dist: J(b.ratingDist || null), reviews: J(b.reviews || []),
    extra: J({ awards: b.awards || [], series: b.series || [], subjects: b.subjects || [], authorBio: b.authorBio || null, titleComplete: b.titleComplete || null, olStats: b.olStats || null, hardcover: b.hardcover || null }),
    fetched_at: b.fetchedAt || now(),
  };
  if (existing) {
    const sets = Object.keys(row).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE books SET ${sets} WHERE id = ?`).run(...Object.values(row), existing.id);
    return existing.id;
  }
  const r = db.prepare(`INSERT INTO books(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  return Number(r.lastInsertRowid);
}
export function getBook(id) {
  const b = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
  return b ? hydrateBook(b) : null;
}
export function getBookByGoodreadsId(gid) {
  const b = db.prepare('SELECT * FROM books WHERE goodreads_id = ?').get(String(gid));
  return b ? hydrateBook(b) : null;
}
export function findBookByTitle(title, author) {
  const b = db.prepare('SELECT * FROM books WHERE lower(title) = lower(?) AND (author IS NULL OR ? IS NULL OR lower(author) = lower(?)) LIMIT 1').get(title, author, author);
  return b ? hydrateBook(b) : null;
}
export function setReviewDigest(bookId, digest) {
  db.prepare('UPDATE books SET review_digest = ? WHERE id = ?').run(J(digest), bookId);
}
export function hydrateBook(b) {
  return { ...b, genres: P(b.genres) || [], rating_dist: P(b.rating_dist), reviews: P(b.reviews) || [], review_digest: P(b.review_digest), extra: P(b.extra) || {} };
}
export function bookSummary(b) {
  // compact form for prompts (no full reviews)
  return { id: b.id, title: b.title, author: b.author, year: b.year, pages: b.pages, genres: b.genres, rating: b.rating, ratings_count: b.ratings_count };
}

// ---------- recommendations ----------
export function addRecommendation({ sessionId, bookId, rank, slot, fit }) {
  const r = db.prepare('INSERT INTO recommendations(session_id, book_id, rank, slot, fit, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, bookId, rank, slot, J(fit), now());
  return Number(r.lastInsertRowid);
}
export function getRecommendations(sessionId) {
  return db.prepare('SELECT r.*, b.title, b.author, b.year, b.pages, b.genres, b.cover, b.url, b.rating, b.ratings_count, b.description, b.review_digest, b.language FROM recommendations r JOIN books b ON b.id = r.book_id WHERE r.session_id = ? ORDER BY r.rank')
    .all(sessionId).map((r) => ({ ...r, fit: P(r.fit), genres: P(r.genres) || [], review_digest: P(r.review_digest) }));
}
export function setRecommendationFeedback(id, feedback, note = null) {
  db.prepare('UPDATE recommendations SET feedback = ?, feedback_note = ? WHERE id = ?').run(feedback, note, id);
}
export function pastRecommendations(limit = 60) {
  return db.prepare('SELECT r.book_id, r.feedback, r.feedback_note, r.created_at, b.title, b.author FROM recommendations r JOIN books b ON b.id = r.book_id ORDER BY r.id DESC LIMIT ?').all(limit);
}

// ---------- shelves ----------
export function listShelves() {
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM shelf_items i WHERE i.shelf_id = s.id) AS count FROM shelves s ORDER BY s.sort, s.id`).all();
}
export function createShelf(name, description = null) {
  const r = db.prepare('INSERT INTO shelves(name, kind, description, sort, created_at) VALUES (?, ?, ?, ?, ?)').run(name, 'custom', description, 100, now());
  return Number(r.lastInsertRowid);
}
export function deleteShelf(id) { db.prepare("DELETE FROM shelves WHERE id = ? AND kind = 'custom'").run(id); }
export function shelfItems(shelfId) {
  return db.prepare(`SELECT i.*, b.title, b.author, b.year, b.pages, b.genres, b.cover, b.url, b.rating, b.ratings_count, b.description
                     FROM shelf_items i JOIN books b ON b.id = i.book_id WHERE i.shelf_id = ? ORDER BY i.added_at DESC`).all(shelfId)
    .map((r) => ({ ...r, genres: P(r.genres) || [], my_verdict: P(r.my_verdict) }));
}
export function addToShelf({ shelfId, bookId, note = null, exclusiveStatus = false }) {
  if (exclusiveStatus) {
    // A book has one "status" shelf among the system reading-state shelves.
    const statusShelves = db.prepare("SELECT id FROM shelves WHERE kind = 'system'").all().map((s) => s.id);
    db.prepare(`DELETE FROM shelf_items WHERE book_id = ? AND shelf_id IN (${statusShelves.map(() => '?').join(',')}) AND shelf_id != ?`).run(bookId, ...statusShelves, shelfId);
  }
  db.prepare(`INSERT INTO shelf_items(shelf_id, book_id, note, added_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(shelf_id, book_id) DO UPDATE SET note = COALESCE(excluded.note, shelf_items.note), updated_at = excluded.added_at`)
    .run(shelfId, bookId, note, now());
}
export function updateShelfItem(id, { note, my_rating, my_verdict }) {
  db.prepare('UPDATE shelf_items SET note = COALESCE(?, note), my_rating = COALESCE(?, my_rating), my_verdict = COALESCE(?, my_verdict), updated_at = ? WHERE id = ?')
    .run(note ?? null, my_rating ?? null, my_verdict ? J(my_verdict) : null, now(), id);
}
export function removeFromShelf(id) { db.prepare('DELETE FROM shelf_items WHERE id = ?').run(id); }
export function shelvesForBook(bookId) {
  return db.prepare('SELECT s.id, s.name FROM shelf_items i JOIN shelves s ON s.id = i.shelf_id WHERE i.book_id = ?').all(bookId);
}
export function allShelvedBooks() {
  return db.prepare(`SELECT b.id, b.title, b.author, s.name AS shelf, i.note, i.my_rating, i.my_verdict, i.added_at
                     FROM shelf_items i JOIN books b ON b.id = i.book_id JOIN shelves s ON s.id = i.shelf_id ORDER BY i.added_at DESC`).all()
    .map((r) => ({ ...r, my_verdict: P(r.my_verdict) }));
}

// ---------- reading history ----------
export function addHistory(h) {
  db.prepare(`INSERT INTO reading_history(book_id, title, author, my_rating, my_review, date_read, status, tags, source, raw, imported_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(title, author, source) DO UPDATE SET my_rating = excluded.my_rating, my_review = excluded.my_review, date_read = excluded.date_read, status = excluded.status, tags = excluded.tags`)
    .run(h.bookId || null, h.title, h.author || null, h.myRating ?? null, h.myReview || null, h.dateRead || null, h.status || 'read', J(h.tags || []), h.source, J(h.raw || null), now());
}
export function listHistory({ limit = 500 } = {}) {
  return db.prepare('SELECT * FROM reading_history ORDER BY COALESCE(date_read, imported_at) DESC LIMIT ?').all(limit).map((r) => ({ ...r, tags: P(r.tags) || [] }));
}
export function deleteHistory(id) { db.prepare('DELETE FROM reading_history WHERE id = ?').run(id); }
export function historyStats() {
  const r = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN my_rating >= 4 THEN 1 ELSE 0 END) AS loved, SUM(CASE WHEN my_rating <= 2 AND my_rating > 0 THEN 1 ELSE 0 END) AS disliked FROM reading_history').get();
  return r;
}

// ---------- chats ----------
export function getChat(bookId, sessionId) {
  // A book's conversation continues across sessions: outside a session, pick up the most recent one about that book.
  const r = sessionId
    ? db.prepare('SELECT * FROM chats WHERE book_id IS ? AND session_id IS ? ORDER BY id DESC LIMIT 1').get(bookId ?? null, sessionId)
    : db.prepare('SELECT * FROM chats WHERE book_id IS ? ORDER BY updated_at DESC LIMIT 1').get(bookId ?? null);
  return r ? { ...r, messages: P(r.messages) || [] } : null;
}
export function saveChat({ id, bookId, sessionId, messages }) {
  if (id) { db.prepare('UPDATE chats SET messages = ?, updated_at = ? WHERE id = ?').run(J(messages), now(), id); return id; }
  const r = db.prepare('INSERT INTO chats(book_id, session_id, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(bookId ?? null, sessionId ?? null, J(messages), now(), now());
  return Number(r.lastInsertRowid);
}
export function clearChat(id) { db.prepare('DELETE FROM chats WHERE id = ?').run(id); }

// ---------- verdicts ----------
export function addVerdict(bookId, verdict) {
  const r = db.prepare('INSERT INTO verdicts(book_id, verdict, created_at) VALUES (?, ?, ?)').run(bookId, J(verdict), now());
  return Number(r.lastInsertRowid);
}
export function latestVerdict(bookId) {
  const r = db.prepare('SELECT * FROM verdicts WHERE book_id = ? ORDER BY id DESC LIMIT 1').get(bookId);
  return r ? { ...r, verdict: P(r.verdict) } : null;
}
export function recentVerdicts(limit = 20) {
  return db.prepare('SELECT v.*, b.title, b.author, b.cover FROM verdicts v JOIN books b ON b.id = v.book_id ORDER BY v.id DESC LIMIT ?').all(limit).map((r) => ({ ...r, verdict: P(r.verdict) }));
}

// ---------- mood log (state answers per session, oldest first) ----------
const MOOD_QS = ['mood_now', 'need_now', 'demand_now', 'tone_now', 'safe_now', 'time_now', 'life_now', 'familiar_now'];
export function moodLog(limit = 60) {
  const rows = db.prepare(`SELECT a.session_id, s.started_at, s.status, a.q_id, a.answer, a.free_text, a.options
                           FROM answers a JOIN sessions s ON s.id = a.session_id
                           WHERE a.layer = 'checkin' AND a.skipped = 0 AND a.q_id IN (${MOOD_QS.map(() => '?').join(',')})
                           ORDER BY a.session_id DESC, a.id`).all(...MOOD_QS);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.session_id)) { if (by.size >= limit) break; by.set(r.session_id, { session_id: r.session_id, at: r.started_at, status: r.status }); }
    const e = by.get(r.session_id);
    const opts = P(r.options) || [];
    const ans = P(r.answer);
    const label = (id) => opts.find((o) => o.id === id)?.label || String(id);
    const key = r.q_id.replace(/_now$/, '');
    if (['demand', 'tone', 'safe'].includes(key)) e[key] = Number(ans) || null;
    else if (Array.isArray(ans)) e[key] = ans.map(label);
    else e[key] = ans != null ? label(ans) : null;
    e[key + '_id'] = ans;
    if (r.free_text) e[key + '_text'] = r.free_text;
  }
  return [...by.values()].sort((x, y) => x.at.localeCompare(y.at));
}

// Evidence stamp: changes whenever something the Reader DNA depends on changes.
export function evidenceStamp() {
  const r = db.prepare(`SELECT (SELECT COUNT(*) FROM answers) AS a, (SELECT COUNT(*) FROM reading_history) AS h,
    (SELECT COUNT(*) || '/' || COALESCE(MAX(updated_at), '') FROM shelf_items) AS s,
    (SELECT COUNT(*) FROM recommendations WHERE feedback IS NOT NULL) AS f`).get();
  return `${r.a}|${r.h}|${r.s}|${r.f}`;
}
