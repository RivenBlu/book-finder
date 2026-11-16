// Operations: daily database backups, a startup health check of the page parsers, profile export and import,
// and the optional home-network mode (off by default; token-protected).
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import * as DB from './db.js';
import { fetchGoodreadsBook, searchGoodreads } from './sources/goodreads.js';
import { searchLubimyczytac } from './sources/lubimyczytac.js';

// ---------- backups ----------
const BACKUPS = join(DB.DATA_DIR, 'backups');
export function backupDatabase({ keep = 7, suffix = '' } = {}) {
  mkdirSync(BACKUPS, { recursive: true });
  const src = join(DB.DATA_DIR, 'bookfinder.db');
  if (!existsSync(src) || process.env.BOOKFINDER_DB) return null;
  const today = new Date().toISOString().slice(0, 10);
  const dest = join(BACKUPS, suffix ? `bookfinder-${today}-${suffix}-${Date.now()}.db` : `bookfinder-${today}.db`);
  if (!existsSync(dest)) {
    // VACUUM INTO writes a consistent copy even while the app is writing.
    DB.db.prepare('VACUUM INTO ?').run(dest);
  }
  if (suffix) return { file: dest };
  const files = readdirSync(BACKUPS).filter((f) => /^bookfinder-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(BACKUPS, f));
  return { file: dest, kept: Math.min(files.length, keep) };
}
export function listBackups() {
  if (!existsSync(BACKUPS)) return [];
  return readdirSync(BACKUPS).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ file: f, bytes: statSync(join(BACKUPS, f)).size }));
}

// ---------- health check of the parsers ----------
export const health = { checkedAt: null, goodreadsSearch: null, goodreadsPage: null, lubimyczytac: null, problems: [] };
export async function checkHealth() {
  const problems = [];
  try { const r = await searchGoodreads('Piranesi Susanna Clarke', { limit: 3, patient: false, count: false }); health.goodreadsSearch = r.length > 0; if (!r.length) problems.push('Goodreads search returned no rows (layout changed or throttled).'); }
  catch (e) { health.goodreadsSearch = false; problems.push(/throttled|not answering|short pause/.test(e.message) ? 'Goodreads is not answering this address right now (it limits how many pages can be read in a while). Searches will wait and retry; it usually clears within the hour.' : 'Goodreads search failed: ' + e.message); }
  try { const b = await fetchGoodreadsBook('50202953', { patient: false, count: false }); health.goodreadsPage = !!(b.title && b.reviews?.length); if (!health.goodreadsPage) problems.push('Goodreads book page parsed without reviews.'); }
  catch (e) { health.goodreadsPage = false; if (!/throttled|not answering|short pause/.test(e.message)) problems.push('Goodreads book page failed: ' + e.message); }
  try { const r = await searchLubimyczytac('Piranesi Clarke'); health.lubimyczytac = r.length > 0; if (!r.length) problems.push('lubimyczytac.pl search returned nothing.'); }
  catch (e) { health.lubimyczytac = false; problems.push('lubimyczytac.pl failed: ' + e.message); }
  health.checkedAt = DB.now(); health.problems = problems;
  DB.setSetting('health', JSON.stringify(health));
  return health;
}

// ---------- profile export / import ----------
const TABLES = ['settings', 'profile_facts', 'sessions', 'answers', 'books', 'recommendations', 'shelves', 'shelf_items', 'reading_history', 'chats', 'verdicts', 'notes', 'debriefs'];
export function exportAll() {
  const out = { format: 'book-finder-export', version: 2, exported_at: DB.now(), tables: {} };
  for (const t of TABLES) {
    let rows = DB.db.prepare(`SELECT * FROM ${t}`).all();
    if (t === 'settings') rows = rows.filter((r) => !/token|health|lan_/.test(r.key));
    out.tables[t] = rows;
  }
  return out;
}
export function importAll(data, { replace = false } = {}) {
  if (data?.format !== 'book-finder-export') throw new Error('not a Book Finder export');
  const counts = {};
  // Merging keeps the exported row ids; if they collide with local rows, child rows would attach to the wrong
  // parent (another session's answers). Refuse instead of corrupting, and say what to do.
  if (!replace) {
    for (const t of TABLES.filter((x) => x !== 'settings')) {
      const ids = (data.tables?.[t] || []).map((r) => r.id).filter((x) => x != null);
      if (!ids.length) continue;
      const clash = DB.db.prepare(`SELECT count(*) n FROM ${t} WHERE id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(ids)).n;
      if (clash) throw new Error(`Cannot merge: ${clash} ${t} rows have the same ids as rows already here. Use "Replace everything" instead (a backup is made first).`);
    }
  }
  if (replace) backupDatabase({ suffix: 'before-import' });
  // The foreign-key pragma has no effect inside a transaction, so it is switched off before BEGIN.
  DB.db.exec('PRAGMA foreign_keys = OFF');
  DB.db.exec('BEGIN');
  try {
    // Replace keeps what the export deliberately leaves out (tokens, home-network mode, health).
    if (replace) for (const t of [...TABLES].reverse()) DB.db.exec(t === 'settings' ? "DELETE FROM settings WHERE key NOT LIKE '%token%' AND key NOT LIKE 'lan_%' AND key != 'health'" : `DELETE FROM ${t}`);
    for (const t of TABLES) {
      const rows = data.tables?.[t] || [];
      if (!rows.length) continue;
      const cols = DB.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const use = Object.keys(rows[0]).filter((c) => cols.includes(c));
      const stmt = DB.db.prepare(`INSERT OR IGNORE INTO ${t}(${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`);
      let n = 0;
      for (const r of rows) { const res = stmt.run(...use.map((c) => (r[c] === undefined ? null : r[c]))); n += Number(res.changes); }
      counts[t] = n;
    }
    DB.db.exec('COMMIT');
  } catch (e) { DB.db.exec('ROLLBACK'); throw e; }
  finally { DB.db.exec('PRAGMA foreign_keys = ON'); }
  return counts;
}

// ---------- home-network mode ----------
export function lanStatus() {
  const enabled = DB.getSetting('lan_enabled', 'false') === 'true';
  const token = DB.getSetting('lan_token', '');
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  return { enabled, hasToken: !!token, ips };
}
export function setLan(enabled) {
  DB.setSetting('lan_enabled', enabled ? 'true' : 'false');
  // A fresh token every time it is switched on, so old links and cookies stop working after a switch-off.
  if (enabled) DB.setSetting('lan_token', randomBytes(24).toString('base64url'));
  else DB.setSetting('lan_token', '');
  return lanStatus();
}
export function lanToken() { return DB.getSetting('lan_token', ''); }
