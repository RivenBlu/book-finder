// Assemble everything the LLM should know about the reader, compactly.
import { getFacts, listHistory, allShelvedBooks, pastRecommendations, getAnswers, historyStats, moodLog } from '../db.js';
import { questionById } from '../questions.js';

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
  const hist = listHistory({ limit: 5000 }).map((r) => `${r.title} - ${r.author || ''}`);
  const shelved = allShelvedBooks().filter((r) => !['Someday', 'Maybe'].includes(r.shelf)).map((r) => `${r.title} - ${r.author}`);
  const recs = pastRecommendations(400).map((r) => `${r.title} - ${r.author}`);
  return [...new Set([...hist, ...shelved, ...recs])];
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
  };
}
