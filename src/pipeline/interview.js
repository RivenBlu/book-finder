// Interview engine: serves the next question, records answers, writes profile facts, asks the LLM for
// anchor-disambiguation questions (which part of a loved book did the work) and adaptive follow-ups.
import { ONBOARDING, CHECKIN, QUICK_IDS, PATH, PATH_CHECKIN_IDS, GIFT, questionById } from '../questions.js';
import { db, getSession, updateSession, getAnswers, addAnswer, setFact, getFacts, getSetting } from '../db.js';
import { ask } from '../llm.js';
import { ADAPTIVE_SCHEMA, ADAPTIVE_SYSTEM, ANCHORS_SCHEMA, ANCHORS_SYSTEM } from '../prompts.js';
import { fullContext, answersDigest } from './context.js';

export function onboardingDone() {
  const keys = new Set(getFacts({ kind: 'trait' }).map((f) => f.key));
  return keys.has('onboarding_completed') || ONBOARDING.every((q) => keys.has(q.id));
}
function anchorsDone() {
  return getFacts({ kind: 'trait' }).some((f) => f.key.startsWith('anchor_') || f.key === 'anchors_completed');
}

function plannedQuestions(session) {
  if (session.mode === 'onboarding') return ONBOARDING;
  if (session.mode === 'gift') return GIFT;
  const list = [];
  // A full session includes the taste questions when they were never completed, or when this session already started them.
  const startedHere = getAnswers(session.id).some((a) => a.layer === 'onboarding');
  if (session.mode === 'full' && (!onboardingDone() || startedHere)) list.push(...ONBOARDING);
  if (session.mode === 'quick') list.push(...CHECKIN.filter((q) => QUICK_IDS.includes(q.id)));
  else if (session.mode === 'path') list.push(...CHECKIN.filter((q) => PATH_CHECKIN_IDS.includes(q.id)), ...PATH);
  else list.push(...CHECKIN);
  return list;
}

// Anchor questions are asked right after the taste questions, once, in full and onboarding sessions.
function wantsAnchors(session) {
  if (!['full', 'onboarding'].includes(session.mode)) return false;
  if (anchorsDone()) return false;
  const loved = getFacts({ kind: 'trait' }).find((f) => f.key === 'loved_books');
  return !!(loved?.value?.text);
}

export function nextQuestion(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error('no such session');
  const answered = new Set(getAnswers(sessionId).map((a) => a.q_id));
  const planned = plannedQuestions(session);
  const adaptiveN = ['onboarding'].includes(session.mode) ? 0 : (session.adaptive?.length ?? Number(getSetting('adaptive_count', '3')));
  const anchorN = session.anchors?.length ?? (wantsAnchors(session) ? 4 : 0);
  // Order: taste questions, anchor questions, then the state questions, then adaptive follow-ups.
  const onboardingPart = planned.filter((q) => q.layer === 'onboarding');
  const rest = planned.filter((q) => q.layer !== 'onboarding');
  const total = planned.length + anchorN + adaptiveN;
  let index = 0;
  for (const q of onboardingPart) { if (!answered.has(q.id)) return { question: withPrefill(q), index, total, phase: 'onboarding' }; index++; }
  if (wantsAnchors(session) || session.anchors?.length) {
    if (!session.anchors) return { needsAnchors: true, index, total };
    for (const q of session.anchors) { if (!answered.has(q.id)) return { question: q, index, total, phase: 'anchors' }; index++; }
  }
  for (const q of rest) { if (!answered.has(q.id)) return { question: withPrefill(q), index, total, phase: q.layer }; index++; }
  if (session.mode === 'onboarding') return { done: true, index, total };
  const adaptive = session.adaptive || null;
  if (!adaptive) return adaptiveN > 0 ? { needsAdaptive: true, index, total } : { done: true, index, total };
  for (const q of adaptive) { if (!answered.has(q.id)) return { question: q, index, total: planned.length + anchorN + adaptive.length, phase: 'adaptive' }; index++; }
  return { done: true, index, total: planned.length + anchorN + adaptive.length };
}

// For trait questions, show the previous answer so the reader can confirm quickly.
function withPrefill(q) {
  if (q.layer !== 'onboarding') return q;
  const f = getFacts({ kind: 'trait' }).find((x) => x.key === q.id);
  return f ? { ...q, previous: f.value } : q;
}

export function recordAnswer(sessionId, { qId, answer, freeText, skipped }) {
  const session = getSession(sessionId);
  const q = questionById(qId) || (session.adaptive || []).find((x) => x.id === qId) || (session.anchors || []).find((x) => x.id === qId);
  if (!q) throw new Error('unknown question ' + qId);
  addAnswer({ sessionId, qId, layer: q.layer || 'adaptive', question: q.text, options: q.options || null, answer: answer ?? null, freeText: freeText || null, skipped: !!skipped });
  if (!skipped) {
    const value = { answer: answer ?? null, text: freeText || null, labels: labels(q, answer) };
    if (q.layer === 'onboarding') setFact({ key: qId, value, kind: 'trait', confidence: 0.9, source: 'answer', sessionId });
    else if (q.layer === 'anchors') setFact({ key: qId, value: { ...value, book: q.book, kind: q.kind }, kind: 'trait', confidence: 0.9, source: 'answer', sessionId, note: `${q.kind}: ${q.book}` });
    else if (q.layer === 'gift') { /* about someone else: stays in the session only */ }
    else setFact({ key: qId, value, kind: 'state', confidence: 0.9, source: 'answer', sessionId });
  }
  if (q.layer === 'anchors') {
    const seen = new Set(getAnswers(sessionId).map((a) => a.q_id));
    if ((session.anchors || []).every((aq) => seen.has(aq.id))) setFact({ key: 'anchors_completed', value: true, kind: 'trait', confidence: 1, source: 'answer', sessionId });
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
  if (last.layer === 'anchors') db.prepare("DELETE FROM profile_facts WHERE key = 'anchors_completed' AND session_id = ?").run(sessionId);
  return { previous: { answer: last.answer, freeText: last.free_text } };
}

export async function generateAnchors(sessionId) {
  const facts = getFacts({ kind: 'trait' });
  const loved = facts.find((f) => f.key === 'loved_books')?.value?.text || '';
  const abandoned = facts.find((f) => f.key === 'abandoned_books')?.value?.text || '';
  if (!loved.trim()) { updateSession(sessionId, { anchors: [] }); return []; }
  const prompt = `LOVED (reader's words):\n${loved}\n\nABANDONED OR DISLIKED (reader's words):\n${abandoned || '(none given)'}\n\nWrite the anchor questions.`;
  const { data } = await ask({ system: ANCHORS_SYSTEM, prompt, schema: ANCHORS_SCHEMA, tier: getSetting('tier_adaptive', 'smart'), effort: 'medium' });
  const qs = (data.questions || []).slice(0, 7).map((q, i) => ({
    id: `anchor_${i + 1}_${q.book.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)}`,
    layer: 'anchors', type: 'multi', text: q.text, help: q.kind === 'loved' ? 'Pick what did the work. More than one is fine.' : 'Pick what made you stop.',
    book: q.book, kind: q.kind,
    options: q.options.map((o, j) => ({ id: o.id || `o${j + 1}`, label: o.label, hint: o.hint || '' })),
  }));
  updateSession(sessionId, { anchors: qs });
  return qs;
}

export async function generateAdaptive(sessionId) {
  const session = getSession(sessionId);
  const n = Number(getSetting('adaptive_count', '3'));
  if (n <= 0) { updateSession(sessionId, { adaptive: [] }); return []; }
  const ctx = session.mode === 'gift' ? { gift: true, note: 'This interview is about another person (a gift). Only the session answers describe them.', session_answers: answersDigest(sessionId) } : fullContext(sessionId);
  const extra = session.mode === 'path' ? ' The reader is designing a READING PATH (several books in order over weeks); ask what sharpens the arc: the first step, the destination, or the thread.' : session.mode === 'gift' ? ' The books are a GIFT for the person described; ask what narrows the choice for them.' : '';
  const prompt = `READER CONTEXT (JSON):\n${JSON.stringify(ctx, null, 1)}\n\nDesign ${Math.min(n, 4)} follow-up questions (or fewer if the picture is already sharp). Prefer one "pair" question with invented micro-blurbs.${extra}`;
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
