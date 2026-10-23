// Learning from outcomes: the loop closer, "say versus do", the appeal fingerprint, periodic reports,
// enriching imported history with real data, and "which book by this author next".
import * as DB from '../db.js';
import { ask } from '../llm.js';
import { REPORT_SCHEMA, REPORT_SYSTEM, AUTHOR_NEXT_SCHEMA, AUTHOR_NEXT_SYSTEM } from '../prompts.js';
import { enrichCandidate, digestBook } from './recommend.js';
import { readerDna, traitProfile, historyDigest } from './context.js';
import { sayVsDo, fingerprint, fingerprintCompact, counter } from './evidence.js';
export { sayVsDo, fingerprint, fingerprintCompact };

// ---------- loop closer ----------
export function followups(excludeSessionId = null) { return DB.pendingFollowups(excludeSessionId, 6); }

/** outcome: finished | dropped | later | not_interested. page/reason/rating optional. */
export function recordOutcome(recId, { outcome, page = null, reason = null, rating = null }) {
  const rec = DB.db.prepare('SELECT * FROM recommendations WHERE id = ?').get(recId);
  if (!rec) throw new Error('no such recommendation');
  const shelves = DB.listShelves();
  const shelf = (name) => shelves.find((s) => s.name === name);
  const note = [page ? `stopped around page ${page}` : null, reason].filter(Boolean).join(': ') || null;
  const at = DB.now();
  if (outcome === 'finished') {
    DB.setRecommendationFeedback(recId, 'finished', reason, { outcome, rating, reason, at });
    DB.addToShelf({ shelfId: shelf('Finished').id, bookId: rec.book_id, note: null, exclusiveStatus: true });
    const item = DB.shelfItemFor(rec.book_id, 'Finished');
    if (item) DB.updateShelfItem(item.id, { my_rating: rating || null, my_verdict: reason ? { text: reason } : null });
  } else if (outcome === 'dropped') {
    DB.setRecommendationFeedback(recId, 'dropped', note, { outcome, page, reason, at });
    DB.addToShelf({ shelfId: shelf('Did not finish').id, bookId: rec.book_id, note, exclusiveStatus: true });
    if (reason) DB.setFact({ key: 'dnf_' + rec.book_id, value: { note, page }, kind: 'trait', confidence: 0.7, source: 'feedback', note: 'Dropped a recommendation' });
  } else if (outcome === 'not_interested') {
    DB.setRecommendationFeedback(recId, 'not_for_me', reason, { outcome, reason, at });
    DB.addToShelf({ shelfId: shelf('Not for me').id, bookId: rec.book_id, note: reason, exclusiveStatus: true });
    if (reason) DB.setFact({ key: 'rejected_' + rec.book_id, value: { note: reason }, kind: 'trait', confidence: 0.6, source: 'feedback', note: 'Rejected recommendation' });
  } else {
    DB.setRecommendationFeedback(recId, 'later', reason, { outcome, reason, at });
    DB.addToShelf({ shelfId: shelf('Up next').id, bookId: rec.book_id, note: reason, exclusiveStatus: true });
  }
  return { ok: true };
}

// ---------- periodic report ----------
export function reportStats(period = 'quarter') {
  const days = period === 'year' ? 365 : period === 'month' ? 30 : 90;
  const from = new Date(Date.now() - days * 864e5).toISOString();
  const rows = DB.outcomeRows().filter((r) => r.mode !== 'gift');
  const inP = rows.filter((r) => r.created_at >= from);
  const count = (arr, f) => arr.filter(f).length;
  const bySlot = {};
  for (const r of inP) { const g = (bySlot[(r.slot || '').replace(/_/g, ' ')] ||= { picks: 0, finished: 0, dropped: 0 }); g.picks++; if (r.feedback === 'finished') g.finished++; if (r.feedback === 'dropped') g.dropped++; }
  const conf = (arr) => arr.length ? +(arr.reduce((a, r) => a + (r.fit?.confidence || 0), 0) / arr.length).toFixed(2) : null;
  const moods = DB.moodLog(500);
  const dist = (arr, k) => counter(arr.map((m) => m[k])).slice(0, 4).map(([v, n]) => `${v} ×${n}`);
  const recentMoods = moods.filter((m) => m.at >= from), earlier = moods.filter((m) => m.at < from);
  const history = DB.listHistory({ limit: 5000 }).filter((h) => (h.date_read || h.imported_at) >= from);
  const verdicts = DB.recentVerdicts(200).filter((v) => v.created_at >= from);
  const notes = DB.listNotes({ limit: 500 }).filter((n) => n.created_at >= from);
  return {
    period, from: from.slice(0, 10), days,
    recommendations: { picks: inP.length, finished: count(inP, (r) => r.feedback === 'finished'), dropped: count(inP, (r) => r.feedback === 'dropped'), later: count(inP, (r) => r.feedback === 'later' || r.feedback === 'saved'), rejected: count(inP, (r) => r.feedback === 'not_for_me'), untold: count(inP, (r) => !r.feedback) },
    by_slot: bySlot,
    drop_reasons: inP.filter((r) => r.feedback === 'dropped').map((r) => `${r.title}: ${r.feedback_note || r.outcome?.reason || 'no reason given'}`),
    finished_titles: inP.filter((r) => r.feedback === 'finished').map((r) => `${r.title}${r.outcome?.rating ? ' (' + r.outcome.rating + '/5)' : ''}`),
    calibration: { confidence_when_finished: conf(inP.filter((r) => r.feedback === 'finished')), confidence_when_dropped: conf(inP.filter((r) => r.feedback === 'dropped')) },
    moods: { checkins: recentMoods.length, mood_now: dist(recentMoods, 'mood'), need_now: dist(recentMoods, 'need'), mood_before: dist(earlier, 'mood'), need_before: dist(earlier, 'need') },
    history_added: history.length, verdicts: verdicts.length, notes: notes.length,
    say_vs_do: sayVsDo().sentences.slice(0, 6),
  };
}
export async function writeReport(period = 'quarter') {
  const stats = reportStats(period);
  const key = `report_${period}_${new Date().toISOString().slice(0, 10)}`;
  const cached = DB.getSetting(key);
  if (cached) return { stats, narrative: JSON.parse(cached), cached: true };
  const prompt = `STATISTICS (JSON):\n${JSON.stringify(stats, null, 1)}\n\nREADER DNA:\n${readerDna() || '(none)'}\n\nFINGERPRINT:\n${JSON.stringify(fingerprintCompact() || '(not enough evidence)')}\n\nWrite the ${period} report.`;
  const { data } = await ask({ system: REPORT_SYSTEM, prompt, schema: REPORT_SCHEMA, tier: DB.getSetting('tier_reflect', 'best'), effort: 'medium' });
  DB.setSetting(key, JSON.stringify(data));
  return { stats, narrative: data, cached: false };
}

// ---------- enrich imported history with real data ----------
export const historyJob = { running: false, done: 0, total: 0, log: [], startedAt: null };
export async function enrichHistory({ limit = 20 } = {}) {
  if (historyJob.running) return historyJob;
  const rows = DB.listHistory({ limit: 5000 }).filter((h) => !h.book_id);
  const prio = (h) => (h.my_rating === 5 ? 0 : h.my_rating && h.my_rating <= 2 ? 1 : h.status === 'dnf' ? 2 : h.my_rating === 4 ? 3 : h.my_rating === 1 ? 1 : 9);
  const todo = rows.filter((h) => prio(h) < 9).sort((a, b) => prio(a) - prio(b)).slice(0, limit);
  Object.assign(historyJob, { running: true, done: 0, total: todo.length, log: [], startedAt: DB.now() });
  (async () => {
    for (const h of todo) {
      try {
        const book = await enrichCandidate({ title: h.title, author: h.author || '', search_query: `${h.title} ${h.author || ''}` });
        if (book) {
          DB.linkHistoryBook(h.id, book.id);
          if (DB.digestStale(book)) await digestBook(book);
          historyJob.log.push(`Linked: ${h.title}`);
        } else historyJob.log.push(`Not found: ${h.title}`);
      } catch (e) { historyJob.log.push(`Failed: ${h.title}: ${e.message}`); }
      historyJob.done++;
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500)); // polite to Goodreads
    }
    historyJob.running = false;
  })();
  return historyJob;
}

// ---------- which book by this author next ----------
export async function authorNext(bookId, { force = false } = {}) {
  const book = DB.getBook(bookId);
  if (!book) throw new Error('no such book');
  if (!force && book.extra?.author_next) return book.extra.author_next;
  const relation = [];
  const h = DB.db.prepare('SELECT my_rating, status FROM reading_history WHERE book_id = ?').get(bookId);
  if (h) relation.push(`history: ${h.status}${h.my_rating ? ', rated ' + h.my_rating + '/5' : ''}`);
  for (const s of DB.shelvesForBook(bookId)) relation.push(`shelf: ${s.name}`);
  const o = DB.db.prepare('SELECT feedback, feedback_note FROM recommendations WHERE book_id = ? AND feedback IS NOT NULL ORDER BY id DESC LIMIT 1').get(bookId);
  if (o) relation.push(`recommendation outcome: ${o.feedback}${o.feedback_note ? ' (' + o.feedback_note + ')' : ''}`);
  const byAuthor = DB.db.prepare('SELECT title FROM reading_history WHERE lower(author) = lower(?)').all(book.author || '').map((r) => r.title);
  const prompt = `BOOK: ${book.title} by ${book.author} (${book.year || '?'}). ${book.genres.slice(0, 6).join(', ')}.\nDigest: ${JSON.stringify(book.review_digest?.one_line || '')}\nREADER'S RELATION TO IT: ${relation.join('; ') || 'none recorded'}\nALREADY READ BY THIS AUTHOR: ${byAuthor.join('; ') || '(nothing recorded)'}\n\nREADER DNA:\n${readerDna() || '(none)'}\nTRAITS (compact): ${JSON.stringify(Object.fromEntries(Object.entries(traitProfile()).filter(([k]) => ['loved_books', 'abandoned_books', 'dealbreakers', 'turnoffs', 'prose_baseline', 'pace_baseline', 'doorway'].includes(k)).map(([k, v]) => [k, v.value?.labels || v.value?.text || v.value])))}\n\nRank the author's other books for this reader.`;
  const { data } = await ask({ system: AUTHOR_NEXT_SYSTEM, prompt, schema: AUTHOR_NEXT_SCHEMA, tier: DB.getSetting('tier_verdict', 'best'), effort: 'medium' });
  const result = { at: DB.now(), ...data };
  DB.db.prepare('UPDATE books SET extra = ? WHERE id = ?').run(JSON.stringify({ ...(book.extra || {}), author_next: result }), bookId);
  return result;
}

export { historyDigest };
