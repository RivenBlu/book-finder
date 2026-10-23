// Hardcover.app GraphQL (optional; sanctioned for personal use). Set a token in Settings to enable.
// Gives crowd moods/genres/tags/content warnings and a rating distribution, independent of Goodreads.
export async function searchHardcover(q, token, { limit = 5 } = {}) {
  if (!token) return [];
  const query = `query ($q: String!, $n: Int!) { search(query: $q, query_type: "Book", per_page: $n, page: 1) { results } }`;
  const r = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'book-finder-personal/0.1' },
    body: JSON.stringify({ query, variables: { q, n: limit } }),
  });
  if (!r.ok) throw new Error(`hardcover ${r.status}`);
  const j = await r.json();
  const res = j?.data?.search?.results;
  const hits = Array.isArray(res?.hits) ? res.hits.map((x) => x.document || x) : Array.isArray(res) ? res : [];
  return hits.map((d) => ({
    hcId: d.id, slug: d.slug, title: d.title, author: d.author_names?.[0] || null, year: d.release_year || null, pages: d.pages || null,
    rating: d.rating ?? null, ratingsCount: d.ratings_count ?? null, usersCount: d.users_count ?? null,
    genres: d.genres || [], moods: d.moods || [], tags: d.tags || [], contentWarnings: d.content_warnings || [], description: d.description || '',
  }));
}
