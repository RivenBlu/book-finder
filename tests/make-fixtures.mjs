// Regenerates the parser fixtures from the live sites (run by hand when a site changes its layout).
// Goodreads pages are large; only the apolloState entries the parser reads are kept, and only five reviews.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(DIR, { recursive: true });
const H = { 'User-Agent': 'book-finder-personal/0.1', 'Accept-Language': 'en-US,en;q=0.9' };

// Goodreads book page (Piranesi)
{
  const html = await (await fetch('https://www.goodreads.com/book/show/50202953', { headers: H })).text();
  const i = html.indexOf('__NEXT_DATA__'); const s = html.indexOf('>', i) + 1; const e = html.indexOf('</script>', s);
  const data = JSON.parse(html.slice(s, e));
  const ap = data.props.pageProps.apolloState; const keep = {};
  let reviews = 0;
  for (const [k, v] of Object.entries(ap)) {
    if (/^(Book|Work|Contributor|Series):/.test(k)) keep[k] = v;
    else if (k.startsWith('Review:') && v?.text && reviews < 5) { keep[k] = v; reviews++; }
  }
  const slim = { props: { pageProps: { apolloState: keep, apiKey: null, dataSource: null } } };
  writeFileSync(join(DIR, 'goodreads-book.html'), `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(slim)}</script></body></html>`);
  console.log('goodreads-book.html', Object.keys(keep).length, 'entries');
}
// Goodreads search page (two rows)
{
  const html = await (await fetch('https://www.goodreads.com/search?q=' + encodeURIComponent('Piranesi Susanna Clarke'), { headers: H })).text();
  const rows = html.split('itemtype="http://schema.org/Book"');
  const slim = rows[0].slice(-200) + rows.slice(1, 3).map((r) => 'itemtype="http://schema.org/Book"' + r.slice(0, 6000)).join('');
  writeFileSync(join(DIR, 'goodreads-search.html'), slim);
  console.log('goodreads-search.html', slim.length, 'bytes');
}
// lubimyczytac search and book page
{
  const sh = await (await fetch('https://lubimyczytac.pl/szukaj/ksiazki?phrase=' + encodeURIComponent('Okruchy dnia Ishiguro'), { headers: { ...H, 'Accept-Language': 'pl' } })).text();
  const cards = sh.split('class="book-card book-card--l');
  writeFileSync(join(DIR, 'lubimyczytac-search.html'), cards.slice(0, 3).map((c, i) => (i ? 'class="book-card book-card--l' : '') + c.slice(0, 5000)).join(''));
  const bh = await (await fetch('https://lubimyczytac.pl/ksiazka/5249583/okruchy-dnia', { headers: { ...H, 'Accept-Language': 'pl' } })).text();
  const ld = [...bh.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[0]).join('\n');
  const tl = bh.match(/Tłumacz:?\s*<\/dt>\s*<dd>[\s\S]*?<\/dd>/i)?.[0] || '';
  const pg = bh.match(/liczba stron:?\s*<\/[^>]+>\s*<[^>]+>\s*\d+/i)?.[0] || '';
  const ot = bh.match(/tytuł oryginału:?\s*<\/[^>]+>\s*<[^>]+>[\s\S]*?<\//i)?.[0] || '';
  writeFileSync(join(DIR, 'lubimyczytac-book.html'), `<html><body><dl><dt>${tl}</dl><div>${pg}</div><div>${ot}</div><p>audiobook</p>${ld}</body></html>`);
  console.log('lubimyczytac fixtures written');
}
