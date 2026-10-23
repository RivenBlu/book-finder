// Open Library: free search + work metadata, no key. Polite User-Agent required.
const H = { 'User-Agent': 'book-finder-personal/0.1 (single-user local tool)' };
const FIELDS = 'key,title,author_name,first_publish_year,ratings_average,ratings_count,want_to_read_count,already_read_count,subject,cover_i,number_of_pages_median,language,isbn';

export async function searchOpenLibrary(q, { limit = 5 } = {}) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&fields=${FIELDS}&limit=${limit}`;
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`openlibrary ${r.status}`);
  const j = await r.json();
  return (j.docs || []).map((d) => ({
    olKey: d.key,
    title: d.title,
    author: d.author_name?.[0] || null,
    year: d.first_publish_year || null,
    rating: d.ratings_average ?? null,
    ratingsCount: d.ratings_count ?? null,
    wantToRead: d.want_to_read_count ?? null,
    alreadyRead: d.already_read_count ?? null,
    subjects: (d.subject || []).slice(0, 25),
    pages: d.number_of_pages_median || null,
    languages: d.language || [],
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    isbn: d.isbn?.[0] || null,
  }));
}

export async function fetchOpenLibraryWork(olKey) {
  const r = await fetch(`https://openlibrary.org${olKey}.json`, { headers: H });
  if (!r.ok) throw new Error(`openlibrary work ${r.status}`);
  const w = await r.json();
  const desc = typeof w.description === 'string' ? w.description : w.description?.value || '';
  return { description: desc, subjects: w.subjects || [], firstPublishDate: w.first_publish_date || null };
}
