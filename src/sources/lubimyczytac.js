// lubimyczytac.pl: Polish ratings (1-10) and real Polish reviews from the book page's JSON-LD. Best effort, personal use, cached.
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) book-finder-personal/0.1', 'Accept-Language': 'pl,en;q=0.8' };
const strip = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

export async function searchLubimyczytac(phrase, { limit = 8 } = {}) {
  const r = await fetch(`https://lubimyczytac.pl/szukaj/ksiazki?phrase=${encodeURIComponent(phrase)}`, { headers: H });
  if (!r.ok) throw new Error(`lubimyczytac search ${r.status}`);
  const html = await r.text();
  const cards = html.split('class="book-card book-card--l').slice(1);
  const out = [];
  for (const c of cards) {
    const id = c.match(/data-book-id="(\d+)"/)?.[1];
    const href = c.match(/class="book-card__title"[^>]*href="([^"]+)"/)?.[1];
    const title = strip(c.match(/class="book-card__title"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '');
    const author = strip(c.match(/class="book-card__author">([\s\S]*?)<\/div>/)?.[1] || '');
    if (id && href) out.push({ lcId: id, url: href.startsWith('http') ? href : 'https://lubimyczytac.pl' + href, title, author });
    if (out.length >= limit) break;
  }
  return out;
}

export async function fetchLubimyczytacBook(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`lubimyczytac book ${r.status}`);
  const html = await r.text();
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
  let book = blocks.find((b) => b['@type'] === 'Book');
  if (!book) for (const b of blocks) { const g = (b['@graph'] || []).find((x) => x['@type'] === 'Book'); if (g) { book = g; break; } }
  if (!book) throw new Error('lubimyczytac: no Book JSON-LD');
  const rating = book.aggregateRating ? Number(String(book.aggregateRating.ratingValue).replace(',', '.')) : null;
  const pages = html.match(/liczba stron:?\s*<\/[^>]+>\s*<[^>]+>\s*(\d+)/i)?.[1];
  const original = strip(html.match(/tytuł oryginału:?\s*<\/[^>]+>\s*<[^>]+>([\s\S]*?)<\//i)?.[1] || '');
  return {
    source: 'lubimyczytac', url, title: book.name, author: book.author?.name || null, originalTitle: original || null,
    rating10: rating, ratingsCount: book.aggregateRating?.ratingCount ?? null, pages: pages ? Number(pages) : null,
    reviews: (book.review || []).map((rv) => ({
      rating: rv.reviewRating?.ratingValue ? Math.round(Number(rv.reviewRating.ratingValue) / 2) : null, // 10 -> 5 scale
      rating10: rv.reviewRating?.ratingValue ? Number(rv.reviewRating.ratingValue) : null,
      text: strip(rv.reviewBody || '').slice(0, 2500), likes: 0, createdAt: rv.datePublished ? String(rv.datePublished).slice(0, 10) : null, lang: 'pl', source: 'lubimyczytac',
    })).filter((x) => x.text.length > 40),
  };
}
