// Run with: npm test   (node --test; no LLM calls, no network; uses a throwaway database)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
process.env.BOOKFINDER_DB = join(mkdtempSync(join(tmpdir(), 'bookfinder-test-')), 'test.db');

const { parseGoodreadsBook, parseGoodreadsSearch } = await import('../src/sources/goodreads.js');
const { parseLubimyczytacBook, parseLubimyczytacSearch } = await import('../src/sources/lubimyczytac.js');
const { parseCsv, importHistoryCsv } = await import('../src/pipeline/reflect.js');
const DB = await import('../src/db.js');
const { recordOutcome } = await import('../src/pipeline/insights.js');
const { sayVsDo, fingerprint } = await import('../src/pipeline/evidence.js');
const { exportAll, importAll } = await import('../src/ops.js');
const { titleMatch } = await import('../src/pipeline/recommend.js');

const fx = (f) => join(DIR, 'fixtures', f);

test('Goodreads book page parses title, stats, genres and reviews', { skip: !existsSync(fx('goodreads-book.html')) && 'no fixture' }, async () => {
  const b = await parseGoodreadsBook(readFileSync(fx('goodreads-book.html'), 'utf8'), '50202953');
  assert.equal(b.title, 'Piranesi');
  assert.match(b.author, /Clarke/);
  assert.ok(b.ratingsCount > 100000);
  assert.ok(Array.isArray(b.ratingDist) && b.ratingDist.length === 5);
  assert.ok(b.genres.length >= 3);
  assert.ok(b.reviews.length >= 3 && b.reviews[0].text.length > 50);
  assert.ok(b.reviews.every((r, i, a) => i === 0 || a[i - 1].likes >= r.likes), 'reviews sorted by likes');
});

test('Goodreads search rows parse', { skip: !existsSync(fx('goodreads-search.html')) && 'no fixture' }, () => {
  const rows = parseGoodreadsSearch(readFileSync(fx('goodreads-search.html'), 'utf8'));
  assert.ok(rows.length >= 1);
  assert.match(rows[0].title, /Piranesi/);
  assert.ok(/^\d+$/.test(rows[0].goodreadsId));
});

test('lubimyczytac search cards and book page parse', { skip: !existsSync(fx('lubimyczytac-book.html')) && 'no fixture' }, () => {
  const hits = parseLubimyczytacSearch(readFileSync(fx('lubimyczytac-search.html'), 'utf8'));
  assert.ok(hits.length >= 1 && hits[0].url.startsWith('https://lubimyczytac.pl/'));
  const b = parseLubimyczytacBook(readFileSync(fx('lubimyczytac-book.html'), 'utf8'), 'https://lubimyczytac.pl/ksiazka/5249583/okruchy-dnia');
  assert.equal(b.title, 'Okruchy dnia');
  assert.ok(b.rating10 > 5 && b.rating10 <= 10);
  assert.equal(b.translator, 'Jan Rybicki');
  assert.ok(b.reviews.length >= 1);
  assert.equal(b.audiobook, true);
});

test('CSV parser handles quotes, commas and CRLF', () => {
  const rows = parseCsv('Title,Author,Rating\r\n"Stoner, a novel","Williams, John",5\r\n"He said ""hi""",X,\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Title, 'Stoner, a novel');
  assert.equal(rows[0].Author, 'Williams, John');
  assert.equal(rows[1].Title, 'He said "hi"');
});

test('Goodreads export import detects source, status and strips series suffix', () => {
  const csv = 'Title,Author,My Rating,Exclusive Shelf,Bookshelves,Date Read,My Review\n"Piranesi (Arcana #1)",Susanna Clarke,5,read,favorites,2024/03/02,Strange and calm\nDune,Frank Herbert,0,to-read,"dnf, abandoned",,\n';
  const r = importHistoryCsv(csv);
  assert.equal(r.source, 'goodreads_csv');
  assert.equal(r.imported, 2);
  const rows = DB.listHistory();
  const p = rows.find((x) => x.title === 'Piranesi');
  assert.ok(p && p.my_rating === 5 && p.status === 'read' && p.date_read === '2024-03-02');
  assert.equal(rows.find((x) => x.title === 'Dune').status, 'to-read');
});

test('profile facts supersede rather than overwrite', () => {
  DB.setFact({ key: 'pace_baseline', value: { labels: ['Fast'] }, kind: 'trait' });
  DB.setFact({ key: 'pace_baseline', value: { labels: ['Leisurely'] }, kind: 'trait' });
  const active = DB.getFacts({ kind: 'trait' }).filter((f) => f.key === 'pace_baseline');
  assert.equal(active.length, 1);
  assert.deepEqual(active[0].value.labels, ['Leisurely']);
  assert.equal(DB.factHistory('pace_baseline').length, 2);
});

test('system shelves are exclusive; custom shelves are not', () => {
  const id = DB.upsertBook({ goodreadsId: '1', title: 'Book One', author: 'A. Author', reviews: [{ text: 'x', likes: 1 }] });
  const shelves = DB.listShelves(); const by = (n) => shelves.find((s) => s.name === n).id;
  DB.addToShelf({ shelfId: by('Up next'), bookId: id, exclusiveStatus: true });
  DB.addToShelf({ shelfId: by('Finished'), bookId: id, exclusiveStatus: true });
  const custom = DB.createShelf('Beach');
  DB.addToShelf({ shelfId: custom, bookId: id });
  const names = DB.shelvesForBook(id).map((s) => s.name).sort();
  assert.deepEqual(names, ['Beach', 'Finished']);
});

test('loop closer: outcomes shelve the book, write facts and feed say-versus-do and the fingerprint', () => {
  const sid = DB.createSession('full');
  const q = { text: 'How are you?', options: [{ id: 'stressed', label: 'Stressed' }] };
  DB.addAnswer({ sessionId: sid, qId: 'mood_now', layer: 'checkin', question: q.text, options: q.options, answer: 'stressed' });
  DB.addAnswer({ sessionId: sid, qId: 'need_now', layer: 'checkin', question: 'Need?', options: [{ id: 'comfort', label: 'Comfort me' }], answer: 'comfort' });
  const digest = { one_line: 'x', appeal: { pace: 'leisurely paced', tone: ['quiet'], style: ['spare'], moods: ['reflective'], demand: 2 } };
  const b1 = DB.upsertBook({ goodreadsId: '11', title: 'Quiet One', author: 'Q', pages: 200, reviews: [{ text: 'a', likes: 0 }] }); DB.setReviewDigest(b1, digest);
  const b2 = DB.upsertBook({ goodreadsId: '12', title: 'Quiet Two', author: 'Q', pages: 500, reviews: [{ text: 'a', likes: 0 }] }); DB.setReviewDigest(b2, { ...digest, appeal: { ...digest.appeal, pace: 'fast-paced' } });
  const r1 = DB.addRecommendation({ sessionId: sid, bookId: b1, rank: 1, slot: 'safe_bet', fit: { kind: 'pick', confidence: 0.8 } });
  const r2 = DB.addRecommendation({ sessionId: sid, bookId: b2, rank: 2, slot: 'stretch', fit: { kind: 'pick', confidence: 0.5 } });
  DB.db.prepare("UPDATE recommendations SET created_at = '2026-01-01T00:00:00.000Z'").run();
  assert.equal(DB.pendingFollowups().length, 2);
  recordOutcome(r1, { outcome: 'finished', rating: 5, reason: 'lovely' });
  recordOutcome(r2, { outcome: 'dropped', page: 60, reason: 'too fast' });
  assert.equal(DB.pendingFollowups().length, 0);
  assert.deepEqual(DB.shelvesForBook(b1).map((s) => s.name), ['Finished']);
  assert.deepEqual(DB.shelvesForBook(b2).map((s) => s.name), ['Did not finish']);
  assert.ok(DB.getFacts({ kind: 'trait' }).some((f) => f.key === 'dnf_' + b2));
  const svd = sayVsDo();
  assert.equal(svd.told, 2);
  assert.ok(svd.need['Comfort me'].finished === 1 && svd.need['Comfort me'].dropped === 1);
  const fp = fingerprint();
  const quiet = fp.rows.find((r) => r.tag === 'quiet');
  assert.ok(quiet && quiet.n === 2 && quiet.finished === 1 && quiet.dnf === 1);
});

test('export and import round-trip into an empty database', () => {
  const data = exportAll();
  assert.equal(data.format, 'book-finder-export');
  assert.ok(data.tables.books.length >= 3);
  process.env.BOOKFINDER_DB2 = '1';
  const counts = importAll(data, { replace: true });
  assert.ok(counts.books >= 3 && counts.profile_facts >= 1);
  assert.equal(DB.listShelves().find((s) => s.name === 'Beach')?.kind, 'custom');
});

test('title matching tolerates subtitles and punctuation', () => {
  assert.equal(titleMatch('Piranesi', 'Piranesi'), 1);
  assert.ok(titleMatch('The Remains of the Day: A Novel', 'The Remains of the Day') >= 0.85);
  assert.ok(titleMatch('Dune', 'Piranesi') < 0.3);
});

test('session anchors and adaptive questions round-trip as objects', () => {
  const sid = DB.createSession('full');
  DB.updateSession(sid, { anchors: [{ id: 'anchor_1_x', layer: 'anchors', type: 'multi', text: 'X?', options: [{ id: 'a', label: 'A' }] }] });
  const s = DB.getSession(sid);
  assert.ok(Array.isArray(s.anchors) && s.anchors.length === 1 && s.anchors[0].id === 'anchor_1_x');
});
