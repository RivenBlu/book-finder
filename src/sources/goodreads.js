// Goodreads: no official API. We read the public book page, which embeds a Next.js
// JSON blob (__NEXT_DATA__) with description, genres, stats and the first ~30 reviews.
// Personal, low-volume use: one page per book, cached in SQLite.

const UA = 'book-finder-personal/0.1 (single-user local tool)';
const H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };

export function decodeHtml(s = '') {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .trim();
}

// Goodreads limits how many pages one address may read in a while, and answers the excess with an empty 202.
// So every request here goes through one polite queue: a short gap between requests, and when Goodreads pushes back
// three times in a row everything pauses together (45 s, then 90 s, then 3 min) instead of each book failing on its own.
// After the third pause the address counts as blocked for now, and callers stop asking.
export const gateConfig = { gap: 650, pauses: [45_000, 90_000, 180_000], retryWait: 1500 };
const gate = { next: 0, until: 0, strikes: 0, level: 0, blockedAt: 0, listener: null };
export function onGoodreadsPause(fn) { gate.listener = fn; }
// Blocked: Goodreads kept refusing through all the pauses. Callers should stop for now; it clears itself after 20 minutes.
export function goodreadsBlocked() { if (gate.blockedAt && Date.now() - gate.blockedAt > 20 * 60_000) { gate.blockedAt = 0; gate.level = 0; gate.strikes = 0; } return !!gate.blockedAt; }
export function resetGoodreadsGate() { Object.assign(gate, { next: 0, until: 0, strikes: 0, level: 0, blockedAt: 0 }); }
async function turn() {
  const now = Date.now();
  const at = Math.max(now, gate.next, gate.until);
  gate.next = at + gateConfig.gap + Math.random() * gateConfig.gap * 0.6;
  if (at > now) await sleep(at - now);
}
function pushedBack() {
  gate.strikes++;
  if (gate.strikes < 3 || Date.now() < gate.until) return;
  gate.strikes = 0;
  if (gate.level >= gateConfig.pauses.length) { gate.blockedAt = Date.now(); return; }
  const ms = gateConfig.pauses[gate.level++];
  gate.until = Date.now() + ms; gate.next = Math.max(gate.next, gate.until);
  try { gate.listener?.(Math.round(ms / 1000)); } catch {}
}
function blockedError() { return Object.assign(new Error('Goodreads is not answering right now'), { blocked: true }); }
async function getHtml(url, { tries = 4 } = {}) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    if (goodreadsBlocked()) throw blockedError();
    await turn();
    if (goodreadsBlocked()) throw blockedError();
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) });
    if (r.status === 429 || r.status === 503) { last = `goodreads ${r.status}`; pushedBack(); await sleep(gateConfig.retryWait * (i + 1)); continue; }
    if (!r.ok) throw new Error(`goodreads ${r.status}`);
    const html = await r.text();
    if (r.status === 202 || html.length < 2000) { last = 'goodreads throttled (empty 202)'; pushedBack(); await sleep(gateConfig.retryWait * (i + 1) * (1 + Math.random() * 0.6)); continue; }
    gate.strikes = 0;
    return html;
  }
  if (goodreadsBlocked()) throw blockedError();
  throw new Error(last || 'goodreads: no response');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchGoodreads(q, { limit = 8 } = {}) {
  const url = `https://www.goodreads.com/search?q=${encodeURIComponent(q)}`;
  return parseGoodreadsSearch(await getHtml(url), { limit });
}
export function parseGoodreadsSearch(html, { limit = 8 } = {}) {
  const rows = html.split('itemtype="http://schema.org/Book"').slice(1);
  const out = [];
  for (const row of rows) {
    const id = row.match(/href="\/book\/show\/(\d+)[^"]*"/)?.[1];
    const title = decodeHtml(row.match(/<span itemprop='name'[^>]*>([^<]*)<\/span>/)?.[1] || '');
    const author = decodeHtml(row.match(/class="authorName"[^>]*><span itemprop="name">([^<]*)<\/span>/)?.[1] || '');
    const mini = row.match(/([\d.]+) avg rating &mdash; ([\d,]+) ratings?/);
    const year = row.match(/published (\d{4})/)?.[1];
    const cover = row.match(/class="bookCover"[^>]*src="([^"]+)"/)?.[1];
    if (id && title) out.push({
      goodreadsId: id, title, author,
      rating: mini ? Number(mini[1]) : null,
      ratingsCount: mini ? Number(mini[2].replace(/,/g, '')) : null,
      year: year ? Number(year) : null,
      cover: cover ? cover.replace(/\._S[XY]\d+_/, '') : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function fetchGoodreadsBook(goodreadsId) {
  const url = `https://www.goodreads.com/book/show/${goodreadsId}`;
  return parseGoodreadsBook(await getHtml(url), goodreadsId, { url, critical: true });
}
export async function parseGoodreadsBook(html, goodreadsId, { url = `https://www.goodreads.com/book/show/${goodreadsId}`, critical = false } = {}) {
  const i = html.indexOf('__NEXT_DATA__');
  if (i < 0) throw new Error('goodreads: no __NEXT_DATA__ (layout changed or blocked)');
  const start = html.indexOf('>', i) + 1;
  const end = html.indexOf('</script>', start);
  const data = JSON.parse(html.slice(start, end));
  const ap = data?.props?.pageProps?.apolloState || {};
  const keys = Object.keys(ap);
  // apolloState holds several partial Book objects (editions, related books); pick the fully loaded one for this id.
  const books = keys.filter((k) => k.startsWith('Book:')).map((k) => ap[k]).filter((b) => b && b.title && b.details);
  const book = books.find((b) => String(b.legacyId) === String(goodreadsId)) || books.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0];
  const works = keys.filter((k) => k.startsWith('Work:')).map((k) => ap[k]).filter((w) => w && w.stats);
  const work = (book?.work?.__ref && ap[book.work.__ref]?.stats ? ap[book.work.__ref] : null) || works[0];
  if (!book) throw new Error('goodreads: no Book in apolloState');
  const contributor = book.primaryContributorEdge?.node?.__ref ? ap[book.primaryContributorEdge.node.__ref] : null;
  const stats = work?.stats || {};
  const reviews = keys.filter((k) => k.startsWith('Review:')).map((k) => ap[k]).filter((rv) => rv && rv.text)
    .map((rv) => ({
      rating: rv.rating ?? null,
      text: decodeHtml(rv.text).slice(0, 2500),
      likes: rv.likeCount ?? 0,
      createdAt: isoDay(rv.createdAt),
      spoiler: rv.spoilerStatus || false,
      shelves: (rv.shelving?.taggings || []).map((t) => t?.tag?.name).filter(Boolean).slice(0, 8),
    }))
    .sort((a, b) => b.likes - a.likes);
  // The page's most-liked reviews skew positive. Ask the site's own review API (key and endpoint come from the page) for
  // the lowest-rated ones too, so "what readers complain about" rests on real one- and two-star reviews.
  try {
    const pp = data?.props?.pageProps || {};
    const workKey = Object.keys(ap).find((k) => k.startsWith('Work:') && ap[k]?.stats);
    if (critical && pp.apiKey && workKey) {
      const endpoint = pp.dataSource?.endpoint || 'https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql';
      const query = 'query getReviews($filters: BookReviewsFilterInput!, $pagination: PaginationInput) { getReviews(filters: $filters, pagination: $pagination) { edges { node { rating text likeCount createdAt } } } }';
      const body = { operationName: 'getReviews', query, variables: { filters: { resourceType: 'WORK', resourceId: workKey.slice(5), ratingMin: 1, ratingMax: 2 }, pagination: { limit: 20 } } };
      const g = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': pp.apiKey, 'User-Agent': UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const j = g.ok ? await g.json() : null;
      const have = new Set(reviews.map((rv) => rv.text.slice(0, 80)));
      for (const e of j?.data?.getReviews?.edges || []) {
        const n = e?.node; if (!n?.text) continue;
        const text = decodeHtml(n.text).slice(0, 2500);
        if (have.has(text.slice(0, 80)) || text.length < 60) continue;
        reviews.push({ rating: n.rating ?? null, text, likes: n.likeCount ?? 0, createdAt: n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : null, spoiler: false, shelves: [], critical: true });
      }
    }
  } catch {}
  const dist = stats.ratingsCountDist || null; // [1*,2*,3*,4*,5*]
  return {
    source: 'goodreads',
    goodreadsId: String(book.legacyId || goodreadsId),
    url: book.webUrl || url,
    title: book.title,
    titleComplete: book.titleComplete,
    author: contributor?.name ? contributor.name.replace(/\s+/g, ' ').trim() : null,
    authorBio: contributor?.description ? decodeHtml(contributor.description).slice(0, 600) : null,
    description: decodeHtml(book['description({"stripped":true})'] || book.description || ''),
    cover: book.imageUrl || null,
    genres: (book.bookGenres || []).map((g) => g?.genre?.name).filter(Boolean),
    pages: book.details?.numPages ?? null,
    language: book.details?.language?.name ?? null,
    publishedAt: yearOf(book.details?.publicationTime),
    originalYear: yearOf(work?.details?.publicationTime),
    series: (book.bookSeries || []).map((s) => ({ title: ap[s?.series?.__ref]?.title || null, position: s?.userPosition || null })),
    awards: (work?.details?.awardsWon || []).map((a) => `${a.name}${a.category ? ' (' + a.category + ')' : ''}`).slice(0, 8),
    rating: stats.averageRating ?? null,
    ratingsCount: stats.ratingsCount ?? null,
    textReviewsCount: stats.textReviewsCount ?? null,
    ratingDist: dist,
    reviews,
    fetchedAt: new Date().toISOString(),
  };
}

// Dates from the page can be missing or odd; a bad one must not abort the whole book.
function isoDay(v) { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
function yearOf(v) { if (!v) return null; const y = new Date(v).getFullYear(); return Number.isFinite(y) ? y : null; }
