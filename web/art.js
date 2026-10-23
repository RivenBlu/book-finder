// Illustrations, drawn in code so they follow the theme tokens (paper, ink, lamp green, amber).
// Everything is decorative (aria-hidden) and animation respects prefers-reduced-motion in styles.css.

const STARS = [[70, 60, 2.2, 0], [120, 110, 1.6, .7], [180, 40, 2.6, 1.4], [240, 86, 1.4, .3], [300, 30, 2, 1.9], [390, 70, 1.8, .9], [440, 120, 2.4, 1.1], [470, 45, 1.5, .5], [150, 150, 1.3, 1.6], [340, 150, 1.5, .2], [410, 170, 1.2, 1.3], [95, 180, 1.4, 2.1]];
const PAGES = [[88, 140, -18, 0], [430, 110, 14, 1.3], [112, 230, 10, 2.1], [455, 215, -12, .6]];

// The hero: an open book from which a night landscape rises; pages drift up like moths.
export const HERO = `
<svg class="hero-art" viewBox="0 0 520 400" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="aGlow" cx="50%" cy="48%" r="52%"><stop offset="0" stop-color="var(--amber)" stop-opacity=".38"/><stop offset=".6" stop-color="var(--amber)" stop-opacity=".08"/><stop offset="1" stop-color="var(--amber)" stop-opacity="0"/></radialGradient>
    <linearGradient id="aSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--lamp)" stop-opacity=".22"/><stop offset="1" stop-color="var(--lamp)" stop-opacity="0"/></linearGradient>
    <mask id="aMoon"><rect width="520" height="400" fill="#fff"/><circle cx="356" cy="104" r="24" fill="#000"/></mask>
  </defs>
  <ellipse cx="260" cy="200" rx="250" ry="175" fill="url(#aGlow)"/>
  <path d="M118 296 C 118 110, 402 110, 402 296 Z" fill="url(#aSky)"/>
  <g class="stars">${STARS.map(([x, y, r, d]) => `<circle class="star" cx="${x}" cy="${y}" r="${r}" fill="var(--amber)" style="animation-delay:${d}s"/>`).join('')}</g>
  <circle cx="342" cy="112" r="28" fill="var(--amber)" mask="url(#aMoon)"/>
  <g fill="none" stroke="var(--ink-2)" stroke-width="1.6" stroke-linecap="round"><path d="M188 150 q 7 -7 14 0 q 7 -7 14 0"/><path d="M222 128 q 5 -5 10 0 q 5 -5 10 0"/><path d="M160 178 q 5 -5 10 0 q 5 -5 10 0"/></g>
  <path d="M132 298 C 170 236, 250 236, 290 270 C 320 250, 360 262, 398 298 Z" fill="var(--lamp)" opacity=".42"/>
  <path d="M150 298 C 200 262, 300 272, 400 298 Z" fill="var(--lamp)" opacity=".72"/>
  <g>
    <rect x="286" y="222" width="22" height="52" rx="2" fill="var(--ink)"/>
    <path d="M282 224 L 297 204 L 312 224 Z" fill="var(--ink)"/>
    <rect x="294" y="236" width="6" height="8" rx="1" fill="var(--amber)"/>
    <rect x="294" y="252" width="6" height="8" rx="1" fill="var(--amber)"/>
  </g>
  <g fill="var(--ink)" opacity=".85"><path d="M172 290 l 10 -26 l 10 26 z"/><path d="M196 292 l 7 -18 l 7 18 z"/><path d="M350 292 l 9 -22 l 9 22 z"/><path d="M372 294 l 6 -14 l 6 14 z"/></g>
  <g class="pages">${PAGES.map(([x, y, rot, d]) => `<g class="page" style="animation-delay:${d}s"><rect x="${x}" y="${y}" width="26" height="34" rx="3" transform="rotate(${rot} ${x + 13} ${y + 17})" fill="var(--surface)" stroke="var(--line-2)" stroke-width="1.2"/><g stroke="var(--line-2)" stroke-width="1.3" stroke-linecap="round" transform="rotate(${rot} ${x + 13} ${y + 17})"><line x1="${x + 6}" y1="${y + 10}" x2="${x + 20}" y2="${y + 10}"/><line x1="${x + 6}" y1="${y + 16}" x2="${x + 20}" y2="${y + 16}"/><line x1="${x + 6}" y1="${y + 22}" x2="${x + 15}" y2="${y + 22}"/></g></g>`).join('')}</g>
  <path d="M54 306 Q 158 282 260 304 Q 362 282 466 306 L 470 352 Q 364 330 260 352 Q 156 330 50 352 Z" fill="var(--lamp)"/>
  <path d="M64 300 Q 160 278 258 298 L 258 344 Q 160 324 62 344 Z" fill="var(--surface)" stroke="var(--line-2)" stroke-width="1.2"/>
  <path d="M456 300 Q 360 278 262 298 L 262 344 Q 360 324 458 344 Z" fill="var(--surface)" stroke="var(--line-2)" stroke-width="1.2"/>
  <path d="M260 298 L 260 345" stroke="var(--line-2)" stroke-width="1.6"/>
  <g stroke="var(--ink-2)" stroke-width="2" stroke-linecap="round" opacity=".35">
    <path d="M86 312 Q 150 300 236 312"/><path d="M86 322 Q 150 310 236 322"/><path d="M86 332 Q 140 322 190 328"/>
    <path d="M284 312 Q 370 300 434 312"/><path d="M284 322 Q 370 310 434 322"/><path d="M284 332 Q 340 326 390 330"/>
  </g>
</svg>`;

// Waiting page: a book whose page keeps turning.
export const FLIP = `
<svg class="flip-art" viewBox="0 0 220 120" aria-hidden="true" focusable="false">
  <path d="M14 98 Q 62 86 110 98 Q 158 86 206 98 L 208 112 Q 158 100 110 112 Q 62 100 12 112 Z" fill="var(--lamp)"/>
  <path d="M20 92 Q 64 80 108 92 L 108 108 Q 64 96 18 108 Z" fill="var(--surface)" stroke="var(--line-2)" stroke-width="1.2"/>
  <path d="M200 92 Q 156 80 112 92 L 112 108 Q 156 96 202 108 Z" fill="var(--surface)" stroke="var(--line-2)" stroke-width="1.2"/>
  <g stroke="var(--line-2)" stroke-width="1.6" stroke-linecap="round"><path d="M36 94 Q 70 86 96 94"/><path d="M36 101 Q 70 93 96 101"/><path d="M124 94 Q 150 86 184 94"/><path d="M124 101 Q 150 93 184 101"/></g>
  <path class="leaf" d="M110 92 Q 150 70 196 90 L 196 94 Q 150 86 110 108 Z" fill="var(--paper)" stroke="var(--line-2)" stroke-width="1.2"/>
  <g class="stars"><circle class="star" cx="60" cy="40" r="2" fill="var(--amber)"/><circle class="star" cx="150" cy="28" r="2.4" fill="var(--amber)" style="animation-delay:.8s"/><circle class="star" cx="110" cy="52" r="1.6" fill="var(--amber)" style="animation-delay:1.5s"/><circle class="star" cx="180" cy="58" r="1.8" fill="var(--amber)" style="animation-delay:.4s"/></g>
</svg>`;

// Empty states: a short stack of books with a sprout of stars.
export const STACK = `
<svg class="spot-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
  <rect x="34" y="84" width="92" height="18" rx="3" fill="var(--lamp)"/>
  <rect x="42" y="64" width="80" height="18" rx="3" fill="var(--amber)"/>
  <rect x="38" y="44" width="70" height="18" rx="3" fill="var(--ink)" opacity=".85"/>
  <g stroke="var(--paper)" stroke-width="2" stroke-linecap="round" opacity=".9"><line x1="48" y1="93" x2="80" y2="93"/><line x1="56" y1="73" x2="84" y2="73"/><line x1="50" y1="53" x2="78" y2="53"/></g>
  <g class="stars"><circle class="star" cx="118" cy="30" r="2.6" fill="var(--amber)"/><circle class="star" cx="134" cy="48" r="1.8" fill="var(--amber)" style="animation-delay:1.1s"/><circle class="star" cx="104" cy="22" r="1.6" fill="var(--amber)" style="animation-delay:.5s"/></g>
</svg>`;

// Reader DNA: a lamp whose light is a page.
export const LAMP = `
<svg class="spot-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
  <path d="M40 30 L 120 30 L 104 54 L 56 54 Z" fill="var(--lamp)"/>
  <rect x="76" y="54" width="8" height="40" rx="2" fill="var(--ink)" opacity=".8"/>
  <rect x="52" y="94" width="56" height="8" rx="3" fill="var(--ink)" opacity=".8"/>
  <path d="M56 54 L 104 54 L 128 100 L 32 100 Z" fill="var(--amber)" opacity=".28"/>
  <g stroke="var(--ink-2)" stroke-width="2" stroke-linecap="round" opacity=".7"><line x1="60" y1="72" x2="100" y2="72"/><line x1="64" y1="80" x2="96" y2="80"/><line x1="68" y1="88" x2="92" y2="88"/></g>
</svg>`;

// A compass rose for the "check a book" and path pages.
export const COMPASS = `
<svg class="spot-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
  <circle cx="80" cy="60" r="44" fill="none" stroke="var(--line-2)" stroke-width="1.5"/>
  <circle cx="80" cy="60" r="30" fill="none" stroke="var(--line)" stroke-width="1"/>
  <path d="M80 18 L 88 60 L 80 102 L 72 60 Z" fill="var(--lamp)"/>
  <path d="M38 60 L 80 52 L 122 60 L 80 68 Z" fill="var(--amber)"/>
  <circle cx="80" cy="60" r="5" fill="var(--paper)" stroke="var(--ink)" stroke-width="1.5"/>
</svg>`;
