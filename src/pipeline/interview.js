// Interview engine: serves the next question, records answers, writes profile facts, asks the LLM for adaptive follow-ups.
import { ONBOARDING, CHECKIN, QUICK_IDS, questionById } from '../questions.js';
import { db, getSession, updateSession, getAnswers, addAnswer, setFact, getFacts, getSetting } from '../db.js';
import { ask } from '../llm.js';
import { ADAPTIVE_SCHEMA, ADAPTIVE_SYSTEM } from '../prompts.js';
import { fullContext } from './context.js';

export function onboardingDone() {
  const keys = new Set(getFacts({ kind: 'trait' }).map((f) => f.key));
  return keys.has('onboarding_completed') || ONBOARDING.every((q) => keys.has(q.id));
}

function plannedQuestions(session) {
  if (session.mode === 'onboarding') return ONBOARDING;
  const list = [];
  // A full session includes the taste questions when they were never completed, or when this session already started them.
  const startedHere = getAnswers(session.id).some((a) => a.layer === 'onboarding');
  if (session.mode === 'full' && (!onboardingDone() || startedHere)) list.push(...ONBOARDING);
  if (session.mode === 'quick') list.push(...CHECKIN.filter((q) => QUICK_IDS.includes(q.id)));
  else list.push(...CHECKIN);
  return list;
}

export function nextQuestion(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error('no such session');
  const answered = new Set(getAnswers(sessionId).map((a) => a.q_id));
  const planned = plannedQuestions(session);
  const total = planned.length + (session.mode === 'onboarding' ? 0 : (session.adaptive?.length ?? 3));
  for (const q of planned) {
    if (!answered.has(q.id)) return { question: withPrefill(q), index: answered.size, total, phase: q.layer };
  }
  if (session.mode === 'onboarding') return { done: true, index: answered.size, total };
  // adaptive layer
  const adaptive = session.adaptive || null;
  if (!adaptive) return { needsAdaptive: true, index: answered.size, total };
  for (const q of adaptive) if (!answered.has(q.id)) return { question: q, index: answered.size, total: planned.length + adaptive.length, phase: 'adaptive' };
  return { done: true, index: answered.size, total: planned.length + adaptive.length };
}

// For trait questions, show the previous answer so the reader can confirm quickly.
function withPrefill(q) {
  if (q.layer !== 'onboarding') return q;
  const f = getFacts({ kind: 'trait' }).find((x) => x.key === q.id);
  return f ? { ...q, previous: f.value } : q;
}

export function recordAnswer(sessionId, { qId, answer, freeText, skipped }) {
  const session = getSession(sessionId);
  const q = questionById(qId) || (session.adaptive || []).find((x) => x.id === qId);
  if (!q) throw new Error('unknown question ' + qId);
  addAnswer({ sessionId, qId, layer: q.layer || 'adaptive', question: q.text, options: q.options || null, answer: answer ?? null, freeText: freeText || null, skipped: !!skipped });
  if (!skipped) {
    const value = { answer: answer ?? null, text: freeText || null, labels: labels(q, answer) };
    if (q.layer === 'onboarding') setFact({ key: qId, value, kind: 'trait', confidence: 0.9, source: 'answer', sessionId });
    else setFact({ key: qId, value, kind: 'state', confidence: 0.9, source: 'answer', sessionId });
  }
  if (!onboardingDone()) {
    const seen = new Set([...getAnswers(sessionId).map((a) => a.q_id), ...getFacts({ kind: 'trait' }).map((f) => f.key)]);
    if (ONBOARDING.every((oq) => seen.has(oq.id))) setFact({ key: 'onboarding_completed', value: true, kind: 'trait', confidence: 1, source: 'answer', sessionId });
  }
}

function labels(q, answer) {
  if (!q.options || answer == null) return null;
  const ids = Array.isArray(answer) ? answer : [answer];
  return ids.map((id) => q.options.find((o) => o.id === id)?.label || String(id));
}

// Back: remove the last answer of this session and restore the previously active fact for that key.
export function undoLastAnswer(sessionId) {
  const last = getAnswers(sessionId).pop();
  if (!last) return null;
  db.prepare('DELETE FROM answers WHERE id = ?').run(last.id);
  db.prepare('DELETE FROM profile_facts WHERE session_id = ? AND key = ?').run(sessionId, last.q_id);
  const prev = db.prepare('SELECT id FROM profile_facts WHERE key = ? ORDER BY id DESC LIMIT 1').get(last.q_id);
  if (prev) db.prepare('UPDATE profile_facts SET active = 1 WHERE id = ?').run(prev.id);
  // Only undoing a taste answer reopens the taste profile; going back during the check-in must not.
  if (last.layer === 'onboarding') db.prepare("DELETE FROM profile_facts WHERE key = 'onboarding_completed' AND session_id = ?").run(sessionId);
  return { previous: { answer: last.answer, freeText: last.free_text } };
}

export async function generateAdaptive(sessionId) {
  const session = getSession(sessionId);
  const ctx = fullContext(sessionId);
  const n = Number(getSetting('adaptive_count', '3'));
  if (n <= 0) { updateSession(sessionId, { adaptive: [] }); return []; }
  const prompt = `READER CONTEXT (JSON):\n${JSON.stringify(ctx, null, 1)}\n\nDesign ${Math.min(n, 4)} follow-up questions (or fewer if the picture is already sharp). Prefer one "pair" question with invented micro-blurbs.`;
  const { data } = await ask({ system: ADAPTIVE_SYSTEM, prompt, schema: ADAPTIVE_SCHEMA, tier: getSetting('tier_adaptive', 'smart'), effort: 'medium' });
  const qs = (data.questions || []).slice(0, 4).map((q, i) => ({
    id: q.id?.startsWith('adaptive_') ? q.id : `adaptive_${i + 1}_${(q.id || 'q').replace(/\W+/g, '_')}`,
    layer: 'adaptive', type: q.type === 'pair' ? 'single' : q.type, text: q.text, help: q.help || '',
    options: q.options.map((o, j) => ({ id: o.id || `o${j + 1}`, label: o.label, hint: o.hint || '' })),
    pair: q.type === 'pair',
  }));
  updateSession(sessionId, { adaptive: qs, adaptive_reasoning: data.reasoning || null });
  return qs;
}
