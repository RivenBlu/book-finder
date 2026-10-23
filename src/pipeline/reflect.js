// Long-term learning: rebuild the Reader DNA from all evidence, and import reading history CSVs.
import { ask } from '../llm.js';
import { REFLECT_SCHEMA, REFLECT_SYSTEM } from '../prompts.js';
import { setFact, getFacts, addHistory, getSetting, setSetting, evidenceStamp, now } from '../db.js';
import { fullContext } from './context.js';

export async function reflectProfile() {
  const ctx = fullContext(null);
  const previous = getFacts({ kind: 'trait' }).filter((f) => f.source === 'inferred').map((f) => `${f.key}: ${JSON.stringify(f.value)} (conf ${f.confidence}, ${f.observed_at.slice(0, 10)})`);
  const prompt = `EVIDENCE (JSON):\n${JSON.stringify(ctx, null, 1)}\n\nPREVIOUSLY INFERRED FACTS:\n${previous.join('\n') || '(none)'}\n\nRebuild the Reader DNA and the inferred facts. Keep facts that still hold; drop or revise those contradicted by newer evidence.`;
  const { data } = await ask({ system: REFLECT_SYSTEM, prompt, schema: REFLECT_SCHEMA, tier: getSetting('tier_reflect', 'best'), effort: 'high' });
  setFact({ key: 'reader_dna', value: data.reader_dna, kind: 'trait', confidence: 0.8, source: 'inferred', note: 'Rebuilt from all evidence' });
  for (const f of data.inferred_facts || []) {
    setFact({ key: 'inferred_' + f.key.replace(/^inferred_/, ''), value: f.value, kind: 'trait', confidence: f.confidence, source: 'inferred', note: f.evidence });
  }
  setFact({ key: 'questions_next_time', value: data.questions_to_ask_next_time || [], kind: 'trait', confidence: 0.5, source: 'inferred' });
  setSetting('last_reflect_at', now());
  setSetting('last_reflect_stamp', evidenceStamp());
  return data;
}

// ---------- CSV import (Goodreads export, StoryGraph export, or a simple Title,Author,Rating list) ----------
export function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const header = (rows.shift() || []).map((h) => h.trim().replace(/^﻿/, ''));
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function importHistoryCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { imported: 0, source: null };
  const cols = Object.keys(rows[0]);
  let source = 'manual_csv';
  if (cols.includes('Exclusive Shelf') || cols.includes('Bookshelves')) source = 'goodreads_csv';
  else if (cols.includes('Read Status') || cols.includes('Star Rating') || cols.includes('Moods')) source = 'storygraph_csv';
  let n = 0;
  for (const r of rows) {
    let h;
    if (source === 'goodreads_csv') {
      const shelf = r['Exclusive Shelf'] || 'read';
      const tags = (r['Bookshelves'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      const status = shelf === 'read' ? 'read' : shelf === 'to-read' ? 'to-read' : shelf === 'currently-reading' ? 'currently-reading' : tags.some((t) => /dnf|abandon/i.test(t)) ? 'dnf' : shelf;
      h = { title: clean(r['Title']), author: r['Author'], myRating: num(r['My Rating']), myReview: r['My Review'] || null, dateRead: r['Date Read'] ? r['Date Read'].replace(/\//g, '-') : null, status, tags, source, raw: r };
    } else if (source === 'storygraph_csv') {
      const rs = (r['Read Status'] || '').toLowerCase();
      const status = rs.includes('did-not-finish') || rs.includes('dnf') ? 'dnf' : rs.includes('to-read') ? 'to-read' : rs.includes('currently') ? 'currently-reading' : 'read';
      const tags = [r['Moods'], r['Pace'], r['Tags']].filter(Boolean).join(', ').split(',').map((s) => s.trim()).filter(Boolean);
      h = { title: clean(r['Title']), author: r['Authors'] || r['Author'], myRating: num(r['Star Rating']), myReview: r['Review'] || null, dateRead: r['Last Date Read'] || r['Dates Read'] || null, status, tags, source, raw: r };
    } else {
      const title = r['Title'] || r['title'] || r['Book'] || Object.values(r)[0];
      const author = r['Author'] || r['author'] || r['Authors'] || Object.values(r)[1] || null;
      const rating = num(r['Rating'] || r['rating'] || r['My Rating'] || r['Stars']);
      h = { title: clean(title), author, myRating: rating, myReview: r['Review'] || r['Notes'] || null, dateRead: r['Date'] || r['Date Read'] || null, status: (r['Status'] || 'read').toLowerCase(), tags: [], source, raw: r };
    }
    if (!h.title) continue;
    addHistory(h); n++;
  }
  return { imported: n, source };
}
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; }
function clean(t = '') { return t.replace(/\s*\(.*?#\d+.*?\)\s*$/, '').trim(); }
