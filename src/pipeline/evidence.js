// Deterministic evidence from outcomes and digests: "say versus do" and the appeal fingerprint. No LLM, no imports beyond the database.
import * as DB from '../db.js';

// ---------- say versus do ----------
const TAGS = (d) => d ? [d.appeal?.pace, ...(d.appeal?.tone || []), ...(d.appeal?.moods || []), ...(d.appeal?.style || [])].filter(Boolean).map((t) => String(t).toLowerCase()) : [];
export function counter(items) { const c = {}; for (const x of items) if (x) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]); }

export function sayVsDo() {
  const moods = Object.fromEntries(DB.moodLog(500).map((m) => [m.session_id, m]));
  const rows = DB.outcomeRows().filter((r) => r.mode !== 'gift');
  const by = { need: {}, mood: {}, slot: {} };
  const bump = (group, key, r) => {
    if (!key) return;
    const g = (by[group][key] ||= { picks: 0, finished: 0, dropped: 0, later: 0, rejected: 0, untold: 0, finishedTags: [], droppedTags: [], finishedTitles: [], droppedTitles: [] });
    g.picks++;
    const f = r.feedback;
    if (f === 'finished' || f === 'already_read') { g.finished++; g.finishedTags.push(...TAGS(r.review_digest)); g.finishedTitles.push(r.title); }
    else if (f === 'dropped') { g.dropped++; g.droppedTags.push(...TAGS(r.review_digest)); g.droppedTitles.push(r.title); }
    else if (f === 'not_for_me') g.rejected++;
    else if (f) g.later++;
    else g.untold++;
  };
  for (const r of rows) {
    const m = moods[r.session_id] || {};
    bump('need', m.need, r); bump('mood', m.mood, r); bump('slot', (r.slot || '').replace(/_/g, ' '), r);
  }
  const finish = (g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { ...v, finishedTags: counter(v.finishedTags).slice(0, 5).map(([t]) => t), droppedTags: counter(v.droppedTags).slice(0, 5).map(([t]) => t) }]));
  const out = { n: rows.length, told: rows.filter((r) => r.feedback).length, need: finish(by.need), mood: finish(by.mood), slot: finish(by.slot), sentences: [] };
  for (const [need, g] of Object.entries(out.need)) {
    if (g.finished + g.dropped < 2) continue;
    let s = `When you asked a book to "${need.toLowerCase()}", you finished ${g.finished} of ${g.finished + g.dropped} you started`;
    if (g.finished && g.finishedTags.length) s += `. What you finished was ${g.finishedTags.slice(0, 3).join(', ')}`;
    if (g.dropped && g.droppedTags.length) s += `; what you dropped was ${g.droppedTags.slice(0, 3).join(', ')}`;
    out.sentences.push(s + '.');
  }
  for (const [mood, g] of Object.entries(out.mood)) {
    if (g.finished + g.dropped < 2) continue;
    out.sentences.push(`Arriving "${mood.toLowerCase()}", you finished ${g.finished} and dropped ${g.dropped}${g.finishedTitles.length ? ` (finished: ${g.finishedTitles.slice(0, 2).join(', ')})` : ''}.`);
  }
  for (const [slot, g] of Object.entries(out.slot)) {
    if (g.finished + g.dropped < 2) continue;
    out.sentences.push(`"${slot}" picks: ${g.finished} finished, ${g.dropped} dropped.`);
  }
  return out;
}

// ---------- appeal fingerprint ----------
export function fingerprint() {
  const books = DB.signalBooks();
  const stats = {};
  const bucket = (p) => (!p ? null : p < 250 ? 'short (under 250 pages)' : p <= 420 ? 'medium length' : 'long (over 420 pages)');
  for (const b of books) {
    const tags = [...TAGS(b.digest), bucket(b.pages), b.digest?.appeal?.demand ? `demand ${b.digest.appeal.demand}/5` : null].filter(Boolean);
    for (const t of new Set(tags)) {
      const s = (stats[t] ||= { tag: t, n: 0, finished: 0, dnf: 0, rejected: 0, ratings: [], titles: [] });
      s.n++; if (b.finished) s.finished++; if (b.dnf) s.dnf++; if (b.rejected) s.rejected++; if (b.rating) s.ratings.push(b.rating); if (s.titles.length < 4) s.titles.push(b.title);
    }
  }
  const rows = Object.values(stats).map((s) => ({ tag: s.tag, n: s.n, finished: s.finished, dnf: s.dnf, rejected: s.rejected, avg_rating: s.ratings.length ? +(s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length).toFixed(2) : null, finish_rate: s.finished + s.dnf ? +(s.finished / (s.finished + s.dnf)).toFixed(2) : null, titles: s.titles }))
    .filter((s) => s.n >= 2).sort((a, b) => b.n - a.n);
  const loved = rows.filter((r) => r.avg_rating && r.n >= 2).sort((a, b) => b.avg_rating - a.avg_rating || b.n - a.n).slice(0, 8);
  const dropped = rows.filter((r) => r.dnf >= 2).sort((a, b) => b.dnf / b.n - a.dnf / a.n).slice(0, 8);
  return { books: books.length, rows: rows.slice(0, 40), loved, dropped };
}
export function fingerprintCompact() {
  const f = fingerprint();
  if (f.books < 3) return null;
  return { books_with_evidence: f.books, loved: f.loved.map((r) => `${r.tag}: avg ${r.avg_rating}/5 over ${r.n}`), dropped: f.dropped.map((r) => `${r.tag}: dropped ${r.dnf} of ${r.n}`), top: f.rows.slice(0, 12).map((r) => `${r.tag}: n=${r.n}, finished ${r.finished}, dnf ${r.dnf}${r.avg_rating ? ', avg ' + r.avg_rating : ''}`) };
}

