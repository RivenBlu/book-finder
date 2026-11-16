// Interview engine: serves the next question, records answers, writes profile facts, asks the LLM for
// anchor-disambiguation questions (which part of a loved book did the work) and adaptive follow-ups.
import { ONBOARDING, CHECKIN, QUICK_IDS, PATH, PATH_CHECKIN_IDS, GIFT, questionById } from '../questions.js';
import { db, getSession, updateSession, getAnswers, addAnswer, setFact, getFacts, getSetting, recentAnswers } from '../db.js';
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
  for (const q of adaptive) { if (!answered.has(q.id)) return { question: withContext(q, getAnswers(sessionId)), index, total: planned.length + anchorN + adaptive.length, phase: 'adaptive' }; index++; }
  return { done: true, index, total: planned.length + anchorN + adaptive.length };
}

// A follow-up written by the model refers back to something she typed several screens (or days) earlier.
// Show her those words with the question, so it still makes sense when she comes back to a half-done interview.
function withContext(q, answers) {
  const said = (id) => (answers.find((a) => a.q_id === id && !a.skipped)?.free_text || '').trim();
  const musts = said('musts_now'), wish = said('wish_now');
  // Only where the question is about her own sentence; on the others the line was noise.
  if (q.must && musts) return { ...q, context: { label: 'You said this is a must', text: musts } };
  if (q.pair && wish) return { ...q, context: { label: 'You asked for', text: wish } };
  return q;
}

// For trait questions, show the previous answer so the reader can confirm quickly.
function withPrefill(q) {
  // Free-text state questions offer what she wrote the last few times as one-tap chips, so a standing wish is never retyped.
  if (q.suggest) {
    const seen = new Set(); const suggestions = [];
    for (const a of recentAnswers(q.id, 12)) { const t = (a.free_text || '').trim(); const k = t.toLowerCase(); if (t && !seen.has(k)) { seen.add(k); suggestions.push({ text: t, at: a.started_at.slice(0, 10) }); } }
    return suggestions.length ? { ...q, suggestions: suggestions.slice(0, 4) } : q;
  }
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
    else if (q.layer === 'gift' || session.mode === 'gift') { /* about someone else: stays in the session only */ }
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
  // Questions written from earlier answers are rewritten if one of those answers is changed.
  const session = getSession(sessionId);
  const left = new Set(getAnswers(sessionId).map((a) => a.q_id));
  if (['loved_books', 'abandoned_books'].includes(last.q_id) && session.anchors && !session.anchors.some((q) => left.has(q.id))) updateSession(sessionId, { anchors: null });
  if (!['adaptive', 'anchors'].includes(last.layer) && session.adaptive && !session.adaptive.some((q) => left.has(q.id))) updateSession(sessionId, { adaptive: null });
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
  // Must-haves are filters, so their meaning is pinned down first: one closed question per must-have that can be read
  // more than one way. These come on top of the ordinary follow-ups, and are asked even when follow-ups are switched off.
  const musts = (getAnswers(sessionId).find((a) => a.q_id === 'musts_now' && !a.skipped)?.free_text || '').trim();
  if (n <= 0 && !musts) { updateSession(sessionId, { adaptive: [] }); return []; }
  const ctx = session.mode === 'gift' ? { gift: true, note: 'This interview is about another person (a gift). Only the session answers describe them.', session_answers: answersDigest(sessionId) } : fullContext(sessionId);
  const extra = session.mode === 'path' ? ' The reader is designing a READING PATH (several books in order over weeks); ask what sharpens the arc: the first step, the destination, or the thread.' : session.mode === 'gift' ? ' The books are a GIFT for the person described; ask what narrows the choice for them.' : '';
  const mustPart = musts ? `\n\nMUST-HAVES. The reader wrote these non-negotiables: "${musts}". They become hard filters, and past searches failed because the tool read a must-have more strictly or more loosely than she meant. So FIRST write one closed question per must-have whose meaning could be read in more than one way (at most 3 such questions, ids prefixed adaptive_must_, type single). Ask for the minimum: "By 'magic', what is the least that counts?" The options run from the loosest reading to the strictest and are concrete, e.g. for "romance": "Any love thread, even a quiet one" / "A real subplot with page time" / "The romance is the main story"; for "high fantasy": "Any invented world" / "Invented world where magic matters" / "Epic scale: kingdoms, wars, magic". For a must-have that is a judgement and cannot be checked as a fact ("well written", "smart", "best in class"), instead offer 5-6 real books as reference points and ask which are at the level she means (type multi; real titles are allowed in this one case, with the author in the hint). Each option is one specific title, never "an author at their best". She can only judge books she knows, so take them mostly from her reading history and shelves, and make the answer informative: span the levels, with two or three she rated highly and two or three popular books of the kind she is asking about that she rated in the middle or dropped. Do not offer only her favourites. Skip a must-have that is already unambiguous ("under 400 pages", "standalone") or that she already illustrated with an example book. These questions do not count towards the number below.` : '';
  const prompt = `READER CONTEXT (JSON):\n${JSON.stringify(ctx, null, 1)}${mustPart}\n\nDesign at most ${Math.min(Math.max(n, 0), 4)} ${musts ? 'further ' : ''}follow-up questions. If you ask any, one of them may be a "pair" question with invented micro-blurbs.${extra}`;
  const { data } = await ask({ system: ADAPTIVE_SYSTEM, prompt, schema: ADAPTIVE_SCHEMA, tier: getSetting('tier_adaptive', 'smart'), effort: 'medium' });
  const NO_PREF = { id: 'no_preference', label: 'No preference', hint: 'Any of these is fine', exclusive: true };
  const qs = (data.questions || []).filter((q) => q.text && q.options?.length >= 2).slice(0, 7).map((q, i) => {
    const must = /^(adaptive_)?must_/.test(q.id || '');
    // A must-have ladder (least to most) is one answer: the minimum that counts. Everything else takes several answers,
    // including the blurb pair and the "which of these books are at that level" kind of must-have question.
    const ladder = must && q.type !== 'multi';
    // The model sometimes still writes its own "either / doesn't matter" option; the page's own answer replaces it.
    // An older habit of the model in a pair: a short handle in the label and the blurb in the hint. The page shows the blurb as the answer.
    const shaped = q.options.map((o, j) => (q.type === 'pair' && o.hint && o.label.length < 40 ? { id: o.id || `o${j + 1}`, label: o.hint, hint: '' } : { id: o.id || `o${j + 1}`, label: o.label, hint: o.hint || '' }));
    const real = shaped.filter((o) => !/^(either|both|any|all)\b|no preference|does ?n[o']t matter|whatever/i.test(o.label.trim()));
    const options = real.length >= 2 ? real : shaped;
    return {
      id: `adaptive_${i + 1}_${(q.id || 'q').replace(/^adaptive_/, '').replace(/\W+/g, '_').slice(0, 40)}`,
      must: must || undefined,
      layer: 'adaptive', type: ladder ? 'single' : 'multi', text: q.text,
      help: ladder ? 'Pick the least that still counts. Anything stronger passes too.' : q.type === 'pair' ? 'Pick every one you would open tonight.' : q.help || '',
      options: ladder || must ? options : [...options, NO_PREF],
      pair: q.type === 'pair',
    };
  });
  updateSession(sessionId, { adaptive: qs, adaptive_reasoning: data.reasoning || null });
  return qs;
}
