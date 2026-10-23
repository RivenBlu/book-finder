// Google Books: optional. Works without a key at a low quota (429s happen); set a key in Settings for reliability.
export async function searchGoogleBooks(q, { key = '', limit = 3 } = {}) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${limit}${key ? `&key=${key}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.items || []).map((it) => {
    const v = it.volumeInfo || {};
    return {
      gbId: it.id, title: v.title, author: v.authors?.[0] || null,
      year: v.publishedDate ? Number(String(v.publishedDate).slice(0, 4)) : null,
      description: v.description || '', categories: v.categories || [], pages: v.pageCount || null,
      rating: v.averageRating ?? null, ratingsCount: v.ratingsCount ?? null, language: v.language || null,
      cover: v.imageLinks?.thumbnail?.replace('http://', 'https://').replace('zoom=1', 'zoom=2') || null,
    };
  });
}
