// Assemble everything the LLM should know about the reader, compactly.
import { db, getFacts, listHistory, allShelvedBooks, pastRecommendations, getAnswers, historyStats, moodLog, listDebriefs, listNotes } from '../db.js';
import { questionById, DEBRIEF } from '../questions.js';
import { sayVsDo, fingerprintCompact, debriefPatterns } from './evidence.js';

// One line per after-reading debrief, newest first: the freshest evidence the tool has.
export function debriefLine(d) {
  const a = d.answers || {};
  const lab = (qid, ids) => { const q = DEBRIEF.find((x) => x.id === qid); return (Array.isArray(ids) ? ids : ids ? [ids] : []).map((id) => q?.options?.find((o) => o.id === id)?.label || String(id)); };
  const parts = [`${d.title}${d.author ? ' - ' + d.author : ''}: ${d.outcome === 'dropped' ? `dropped${d.page ? ' around page ' + d.page : ''}` : 'finished'}${d.rating ? `, ${d.rating}/5` : ''} (${String(d.created_at).slice(0, 10)})`];
  if (a.worked?.length) parts.push(`worked: ${lab('worked', a.worked).join(', ')}`);
  if (a.bothered?.length) parts.push(`bothered: ${lab('bothered', a.bothered).join(', ')}`);
  if (a.fit_mood) parts.push(`did the job: ${a.fit_mood.replace(/_/g, ' ')}`);
  if (a.warning) parts.push(`tool's warning was: ${a.warning.replace(/_/g, ' ')}`);
  if (a.more_like) parts.push(`next: ${lab('more_like', a.more_like).join(', ')}`);
  if (a.followup?.question) parts.push(`asked "${a.followup.question}" -> ${(a.followup.labels || []).join(', ')}`);
  if (d.text) parts.push(`own words: "${String(d.text).slice(0, 300)}"`);
  return parts.join(' | ');
}
export function debriefsDigest(limit = 30) {
  const rows = listDebriefs({ limit });
  if (!rows.length) return undefined;
  const p = debriefPatterns();
  return { note: 'What the reader said right after each book. Freshest evidence; trust it over self-described taste.', patterns: p.sentences.length ? p.sentences : undefined, books: rows.map(debriefLine) };
}

export function traitProfile() {
  const facts = getFacts({ kind: 'trait' });
  const out = {};
  for (const f of facts) out[f.key] = { value: f.value, confidence: f.confidence, source: f.source, observed_at: f.observed_at.slice(0, 10), note: f.note || undefined };
  return out;
}

export function readerDna() {
  const f = getFacts({ kind: 'trait' }).find((x) => x.key === 'reader_dna');
  return f ? f.value : null;
}

export function historyDigest(limit = 120) {
  const rows = listHistory({ limit: 2000 });
  const stats = historyStats();
  const rated = rows.filter((r) => r.my_rating);
  const loved = rated.filter((r) => r.my_rating >= 4).slice(0, limit / 2).map(fmt);
  const disliked = rated.filter((r) => r.my_rating <= 2).slice(0, limit / 4).map(fmt);
  const dnf = rows.filter((r) => r.status === 'dnf').slice(0, 30).map(fmt);
  const reviewed = rows.filter((r) => r.my_review && r.my_review.length > 20).slice(0, 25).map((r) => `${r.title} (${r.author}) ${r.my_rating ? r.my_rating + '/5' : ''}: ${r.my_review.slice(0, 300)}`);
  return { total: stats.n, loved_count: stats.loved, disliked_count: stats.disliked, loved, disliked, dnf, reviews: reviewed };
  function fmt(r) { return `${r.title}${r.author ? ' - ' + r.author : ''}${r.my_rating ? ' (' + r.my_rating + '/5)' : ''}${r.date_read ? ' ' + String(r.date_read).slice(0, 7) : ''}`; }
}

export function shelvesDigest() {
  const rows = allShelvedBooks();
  const by = {};
  for (const r of rows) {
    (by[r.shelf] ||= []).push(`${r.title} - ${r.author}${r.my_rating ? ' (' + r.my_rating + '/5)' : ''}${r.note ? ' | ' + r.note : ''}${r.my_verdict ? ' | ' + JSON.stringify(r.my_verdict) : ''}`);
  }
  return by;
}

export function feedbackDigest() {
  return pastRecommendations(80).filter((r) => r.feedback).map((r) => `${r.title} - ${r.author}: ${r.feedback}${r.feedback_note ? ' (' + r.feedback_note + ')' : ''}`);
}

export function excludeList() {
  // Everything already read, on a shelf, recommended before or rejected: never recommend again (except "Someday"/"Maybe", which may resurface).
  // The list sent to the model is capped (prompt size); the full check happens in code after enrichment (knownBooks()).
  const hist = listHistory({ limit: 600 }).filter((r) => r.status !== 'to-read').map((r) => `${r.title} - ${r.author || ''}`);
  const shelved = allShelvedBooks().filter((r) => !['Someday', 'Maybe', 'Gifts'].includes(r.shelf)).map((r) => `${r.title} - ${r.author}`);
  const recs = pastRecommendations(200).map((r) => `${r.title} - ${r.author}`);
  return [...new Set([...shelved, ...recs, ...hist])].slice(0, 700);
}

export function answersDigest(sessionId) {
  const answers = getAnswers(sessionId);
  return answers.map((a) => {
    const q = questionById(a.q_id);
    let ans = '';
    if (a.skipped) ans = '(skipped)';
    else if (Array.isArray(a.answer)) ans = a.answer.map((id) => labelFor(q, a.options, id)).join(', ');
    else if (a.answer != null) ans = labelFor(q, a.options, a.answer);
    if (a.free_text) ans += (ans ? ' | own words: ' : '') + a.free_text;
    return { id: a.q_id, layer: a.layer, question: a.question, answer: ans };
  });
}
function labelFor(q, options, id) {
  const opts = options || q?.options || [];
  const o = opts.find((x) => x.id === id);
  if (!o) return String(id);
  if (q?.type === 'scale') return `${id}/5${o.label ? ' (' + o.label + ')' : ''}`;
  return o.label + (o.hint ? ` [${o.hint}]` : '');
}

// Follow-up questions from earlier interviews, with her answers. Without this the tool asked the same things
// (heat level, how dark, how central the romance) in every interview and never learned the answer.
export function earlierFollowups(sessionId = null, limit = 30) {
  const rows = db.prepare(`SELECT a.session_id, s.started_at, a.question, a.options, a.answer, a.free_text
                           FROM answers a JOIN sessions s ON s.id = a.session_id
                           WHERE a.layer = 'adaptive' AND a.skipped = 0 AND s.mode != 'gift' AND a.session_id != ?
                           ORDER BY a.id DESC LIMIT ?`).all(sessionId ?? -1, limit);
  return rows.map((r) => {
    const opts = JSON.parse(r.options || '[]'); let ans = null; try { ans = JSON.parse(r.answer); } catch { ans = r.answer; }
    const ids = Array.isArray(ans) ? ans : ans != null ? [ans] : [];
    const picked = ids.map((id) => opts.find((o) => o.id === id)?.label || String(id)).join(' + ');
    return { date: String(r.started_at).slice(0, 10), asked: r.question, offered: opts.map((o) => o.label).join(' / '), answered: [picked, r.free_text ? `own words: ${r.free_text}` : ''].filter(Boolean).join(' | ') };
  });
}

export function fullContext(sessionId) {
  return {
    today: new Date().toISOString().slice(0, 10),
    reader_dna: readerDna(),
    trait_profile: traitProfile(),
    reading_history: historyDigest(),
    shelves: shelvesDigest(),
    past_feedback: feedbackDigest(),
    session_answers: sessionId ? answersDigest(sessionId) : [],
    mood_log: moodLog(12).map((m) => ({ date: m.at.slice(0, 10), mood: m.mood, need: m.need, demand: m.demand, tone: m.tone, safe: m.safe, life: m.life })),
    after_reading: debriefsDigest(),
    earlier_followups: (() => { const f = earlierFollowups(sessionId); return f.length ? f : undefined; })(),
    say_vs_do: (() => { const s = sayVsDo(); return s.sentences.length ? s.sentences : undefined; })(),
    appeal_fingerprint: fingerprintCompact() || undefined,
    underlined: listNotes({ limit: 40 }).filter((n) => n.kind !== 'checkin').slice(0, 25).map((n) => `${n.title ? n.title + ': ' : ''}"${n.text.slice(0, 240)}"`),
    reading_checkins: (() => { const c = listNotes({ limit: 40 }).filter((n) => n.kind === 'checkin').slice(0, 10).map((n) => `${n.title || '?'} (${String(n.created_at).slice(0, 10)}): ${n.text}`); return c.length ? c : undefined; })(),
  };
}
