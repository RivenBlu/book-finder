// Book Finder UI. Vanilla ES module, hash routing, no build step.
const app = document.getElementById('app');
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const get = (u) => api('GET', u), post = (u, b) => api('POST', u, b || {}), patch = (u, b) => api('PATCH', u, b), del = (u) => api('DELETE', u);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const h = (strings, ...vals) => strings.map((s, i) => s + (i < vals.length ? render(vals[i]) : '')).join('');
const render = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : v == null || v === false ? '' : esc(v));
const fmtN = (n) => (n == null ? '?' : Number(n).toLocaleString());
const when = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4000); };
const rating = (r, n) => (r ? raw(h`<span class="rating"><span class="star">★</span>${Number(r).toFixed(1)}${n != null ? raw(h`<span>· ${fmtN(n)}</span>`) : ''}</span>`) : '');
const coverImg = (src, title, cls = 'cover') => (src ? raw(h`<img class="${cls}" src="/api/cover?u=${encodeURIComponent(src)}" alt="${title}" onerror="this.outerHTML='<div class=&quot;${cls} fallback&quot;>'+this.alt.replace(/</g,'')+'</div>'">`) : raw(h`<div class="${cls} fallback">${title}</div>`));
// Minimal, safe Markdown: escape first, then paragraphs, lists, bold/italic.
function md(text) {
  const blocks = String(text || '').trim().split(/\n{2,}/);
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s.,;:!?)]|$)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return blocks.map((b) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
      const ol = /^\s*\d/.test(lines[0]);
      return `<${ol ? 'ol' : 'ul'}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`).join('')}</${ol ? 'ol' : 'ul'}>`;
    }
    if (/^#{1,4}\s/.test(lines[0])) return `<h4>${inline(lines[0].replace(/^#+\s/, ''))}</h4>${lines.length > 1 ? `<p>${lines.slice(1).map(inline).join('<br>')}</p>` : ''}`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}
// POST that streams server-sent events back; onEvent gets each parsed event.
async function streamPost(url, body, onEvent) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) { try { onEvent(JSON.parse(chunk.slice(6))); } catch {} } }
  }
}
const bar = document.getElementById('progressbar');
const setBar = (pct) => { if (pct == null) { bar.hidden = true; return; } bar.hidden = false; bar.firstElementChild.style.width = pct + '%'; };

// ---------- theme ----------
const themeBtn = document.getElementById('themeBtn');
themeBtn.onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('bf-theme', next); } catch {}
  toast(next === 'dark' ? 'Dark theme' : 'Light theme');
};

// ---------- router ----------
const routes = { home, interview, results, shelves, profile, history, settings, book, session: results, check, followups: followupsPage, report };
async function router() {
  const [name, ...args] = (location.hash.slice(1) || 'home').split('/');
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name || (['interview', 'results', 'book', 'session'].includes(name) && a.dataset.nav === 'home')));
  window.onkeydown = null; setBar(null);
  app.className = ['interview', 'home', 'settings', 'check', 'followups', 'report'].includes(name) ? 'narrow' : '';
  app.innerHTML = '<p class="sec ui" style="padding:40px 0">Loading…</p>';
  try { await (routes[name] || home)(...args); } catch (e) { app.innerHTML = h`<div class="section"><h2>Something broke</h2><p class="sec" style="margin-top:8px">${e.message}</p><p style="margin-top:16px"><a class="btn" href="#home">Home</a></p></div>`; }
}
window.addEventListener('hashchange', router);

// ---------- home ----------
async function home() {
  const st = await get('/api/state');
  const recent = st.sessions.filter((s) => s.status !== 'closed').slice(0, 6);
  const first = !st.onboardingDone;
  app.innerHTML = h`
  ${st.health?.problems?.length ? raw(h`<div class="banner warn"><b>Data source problem.</b> ${st.health.problems.join(' ')} Recommendations may fail until it clears; see Settings.</div>`) : ''}
  ${st.followups ? raw(h`<div class="banner"><b>Last time I suggested ${st.followups} ${st.followups === 1 ? 'book' : 'books'}.</b> Thirty seconds on what happened teaches the tool more than anything else. <a class="btn sm primary" href="#followups">Tell me</a></div>`) : ''}
  <section class="hero">
    <div class="eyebrow">${first ? 'Welcome' : 'Good to see you'}</div>
    <h1>What should you read next?</h1>
    <p class="lede">A few closed questions about how you are and what you need. Then real reviews on every candidate, and three to five books with honest reasons.</p>
    <div class="modes">
      <button class="mode primary" data-mode="full"><span class="t">${first ? 'Start the interview' : 'Full interview'}</span><span class="d">${first ? 'About 17 questions about your taste, asked once, then 12 about right now. Eight minutes.' : 'Twelve questions about right now, plus two or three sharp follow-ups. Best results.'}</span><span class="k">Press 1 → 9 to answer</span></button>
      <button class="mode" data-mode="quick"><span class="t">Quick check-in</span><span class="d">Six questions. Uses your saved Reader DNA. For when you already know the mood.</span><span class="k">${first ? 'Available after the first interview' : 'About two minutes'}</span></button>
      <button class="mode" data-mode="onboarding"><span class="t">${first ? 'Taste profile only' : 'Revisit my taste'}</span><span class="d">Loved and abandoned books, dealbreakers, films and music as proxies. No recommendation at the end.</span><span class="k">Previous answers shown for confirming</span></button>
      <button class="mode path" data-mode="path"><span class="t">A reading path</span><span class="d">Two to four books in order over a few weeks, from where you are to where you want to be. Each one moves you a step.</span><span class="k">${first ? 'After the first interview' : 'About ten questions'}</span></button>
      <button class="mode" data-mode="gift"><span class="t">For someone else</span><span class="d">Eight questions about them. Your own taste stays out of it. The picks land on your Gifts shelf.</span><span class="k">Birthday, hard time, just because</span></button>
    </div>
  </section>
  ${recent.length ? raw(h`<section class="section"><div class="eyebrow">Recent</div><div class="recent">${recent.map((s) => raw(h`<div class="r"><div><div class="t">${when(s.started_at)} · ${s.mode === 'quick' ? 'quick check-in' : s.mode === 'onboarding' ? 'taste profile' : 'full interview'} · ${s.status === 'recommended' ? 'done' : s.status === 'researching' ? 'researching' : 'unfinished'}</div>${s.summary ? raw(h`<div class="s">${s.summary.slice(0, 160)}…</div>`) : ''}</div><div class="row"><a class="btn sm" href="#${s.status === 'recommended' ? 'results' : 'interview'}/${s.id}">${s.status === 'recommended' ? 'Open' : 'Continue'}</a><button class="btn sm ghost" data-del="${s.id}" title="Delete">✕</button></div></div>`))}</div></section>`) : ''}
  <section class="section">
    <div class="eyebrow">Thinking about a specific book?</div>
    <form class="row" id="checkForm" style="margin-top:12px"><input type="text" id="checkQ" placeholder="Title and author" style="flex:1;min-width:220px" autocomplete="off"><button class="btn primary">Should I read it?</button></form>
    <p class="cap sec" style="margin-top:8px">Real reviews plus your profile, judged in about a minute. Then you can ask it anything about the book.</p>
    ${st.verdicts?.length ? raw(h`<div class="row" style="margin-top:14px;gap:8px">${st.verdicts.map((v) => raw(h`<a class="chip ${['yes', 'probably'].includes(v.verdict?.verdict) ? 'lamp' : ''}" href="#book/${v.book_id}" title="${v.verdict?.headline || ''}">${v.title} · ${verdictLabel(v.verdict?.verdict)}</a>`))}</div>`) : ''}
  </section>
  <section class="section grid">
    <div><div class="eyebrow">Shelves</div><div class="row" style="margin-top:12px">${st.shelves.filter((s) => s.count || s.kind === 'system').slice(0, 7).map((s) => raw(h`<a href="#shelves/${s.id}" class="chip ${s.count ? 'lamp' : ''}">${s.name} <span class="tabular">${s.count}</span></a>`))}</div></div>
    <div><div class="eyebrow">Reader DNA</div><p class="sec" style="margin-top:12px;font-size:17px">${st.readerDna ? st.readerDna.slice(0, 200) + '…' : 'Not built yet. After the taste questions, import your Goodreads or StoryGraph history and rebuild it on the Reader DNA page.'}</p><p style="margin-top:12px"><a href="#profile" class="btn sm">Open</a></p></div>
  </section>`;
  app.querySelectorAll('.mode').forEach((m) => m.onclick = async () => { const s = await post('/api/sessions', { mode: m.dataset.mode }); location.hash = `interview/${s.id}`; });
  document.getElementById('checkForm').onsubmit = (e) => { e.preventDefault(); const q = document.getElementById('checkQ').value.trim(); if (q) location.hash = `check/${encodeURIComponent(q)}`; };
  app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await del(`/api/sessions/${b.dataset.del}`); router(); });
}

// ---------- interview ----------
const REACT = {
  mood_now: { good_energetic: 'Good. Let us use that.', good_calm: 'Calm is the best reading state there is.', flat: 'Flat is honest. We can work with flat.', stressed: 'Noted. Nothing that feels like homework.', low: 'Okay. No forced cheer.', raw: 'Thank you for saying so. Gently, then.', restless: 'Short chapters, then.' },
  need_now: { distract: 'Grip first, everything else second.', comfort: 'Warm and safe. Got it.', sit_with_it: 'No flinching, no fixing.', thrill: 'Dread and twists, coming up.', think: 'Ideas with teeth.', laugh: 'Funny is the hardest brief. Noted.', awe: 'Scale and strangeness.', learn: 'Something true, well told.', feel: 'Tissues on standby.' },
  demand_now: { 1: 'Easy. The book carries you.', 2: 'Light on effort.', 3: 'Medium effort.', 4: 'Up for some work.', 5: 'Demanding. You want to work.' },
  time_now: { one_sitting: 'Short and immersive.', this_week: 'A week or two. Good range.', slow_month: 'A companion book.', commute: 'Fragment-friendly, then.', audio: 'The narrator will matter.' },
  familiar_now: { familiar: 'More of what works.', adjacent: 'Same feeling, new ground.', strange: 'A wildcard slot, then.' },
  tone_now: { 1: 'Light it is.', 5: 'Dark it is.' }, safe_now: { 1: 'Nothing that will haunt you.', 5: 'You can take it. Noted.' },
  form_now: { fiction: 'Fiction.', nonfiction: 'Nonfiction.', either: 'Whatever fits.' },
  abandoned_books: { _: 'This is the most useful answer you will give.' }, loved_books: { _: 'Thank you. That tells me a lot.' }, dealbreakers: { _: 'These become hard filters.' }, proxies: { _: 'Taste crosses media. Noted.' },
};
const reactionFor = (q, answer, text) => { const m = REACT[q.id]; if (!m) return text ? 'Read and noted.' : 'Noted.'; const key = Array.isArray(answer) ? answer[0] : answer; return m[key] || m._ || 'Noted.'; };

async function interview(id) {
  const s = await get(`/api/sessions/${id}`);
  if (s.status === 'recommended') return (location.hash = `results/${id}`);
  if (s.status === 'researching' || s.running) return renderProgress(id);
  // Loop closer: before a new interview, ask what happened with the last picks (once per session).
  let asked = false; try { asked = sessionStorage.getItem('bf-fu-' + id) === '1'; } catch {}
  if (!asked && !s.answers.length && ['full', 'quick', 'path'].includes(s.mode)) {
    const fu = await get(`/api/followups?exclude=${id}`);
    if (fu.length) { try { sessionStorage.setItem('bf-fu-' + id, '1'); } catch {} return renderFollowups(fu, () => interview(id)); }
  }
  renderQuestion(id, await get(`/api/sessions/${id}/next`), s.mode, '');
}

// ---------- loop closer ----------
const OUTCOMES = [['finished', 'Finished it', 'Rate it and say a word'], ['dropped', 'Dropped it', 'Where, and why'], ['later', 'Have not started, keep it', 'Stays on Up next'], ['not_interested', 'Not interested after all', 'One line teaches the tool']];
function renderFollowups(list, done) {
  let i = 0;
  const step = () => {
    if (i >= list.length) { setBar(null); return done(); }
    const r = list[i];
    setBar(Math.round((i / list.length) * 100));
    app.innerHTML = h`<div class="interview"><div class="q">
      <div class="meta"><span class="eyebrow">What happened · <span class="tabular">${i + 1} of ${list.length}</span></span></div>
      <div class="fuhead">${coverImg(r.cover, r.title, 'cover small')}<div><div class="text" style="margin-bottom:4px">${r.title}</div><div class="help" style="margin-bottom:0">${r.author} · suggested ${when(r.created_at)}${r.fit?.headline ? raw(h` · <i>${r.fit.headline}</i>`) : ''}</div></div></div>
      <div class="opts" style="margin-top:20px">${OUTCOMES.map(([id, label, hint], k) => raw(h`<button class="opt" data-id="${id}"><span class="kbd">${k + 1}</span><span><span class="l">${label}</span><span class="h">${hint}</span></span><span class="ck">✓</span></button>`))}</div>
      <div id="detail" hidden style="margin-top:16px"></div>
      <div class="qactions"><button class="btn primary" id="next" hidden>Save and continue <span class="kbd" style="background:transparent;color:inherit;border-color:currentColor;opacity:.7">↵</span></button><button class="btn ghost" id="skipAll">Skip for now</button><span class="hint">Press a number.</span></div>
    </div></div>`;
    let outcome = null;
    const detail = document.getElementById('detail'); const next = document.getElementById('next');
    const pick = (id) => {
      outcome = id; app.querySelectorAll('.opt').forEach((x) => x.classList.toggle('on', x.dataset.id === id));
      detail.hidden = false; next.hidden = false;
      if (id === 'finished') detail.innerHTML = h`<label class="lbl">Your rating</label><div class="rating-input" data-r="0">${[1, 2, 3, 4, 5].map((n) => raw(h`<span data-n="${n}">★</span>`))}</div><label class="lbl">What worked, what did not? One line is plenty.</label><textarea id="reason" rows="2"></textarea>`;
      else if (id === 'dropped') detail.innerHTML = h`<label class="lbl">Around which page?</label><input type="number" id="page" min="1" style="width:120px" placeholder="${r.pages ? 'of ' + r.pages : ''}"><label class="lbl">Why? Honest and short. This is the most useful answer in the app.</label><textarea id="reason" rows="2" placeholder="e.g. nothing happened for 80 pages; disliked the narrator; too sad for this month"></textarea>`;
      else if (id === 'not_interested') detail.innerHTML = h`<label class="lbl">Why not? One line.</label><textarea id="reason" rows="2"></textarea>`;
      else detail.innerHTML = h`<p class="cap sec">Kept on Up next. It will not be suggested again, and I will ask again later.</p>`;
      const ri = detail.querySelector('.rating-input'); if (ri) ri.querySelectorAll('span').forEach((sp) => sp.onclick = () => { ri.dataset.r = sp.dataset.n; ri.querySelectorAll('span').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) <= Number(sp.dataset.n))); });
      const ta = detail.querySelector('textarea'); if (ta) ta.focus();
    };
    app.querySelectorAll('.opt').forEach((b) => b.onclick = () => pick(b.dataset.id));
    next.onclick = async () => {
      if (!outcome) return;
      const body = { outcome, reason: detail.querySelector('#reason')?.value.trim() || null, page: Number(detail.querySelector('#page')?.value) || null, rating: Number(detail.querySelector('.rating-input')?.dataset.r) || null };
      await post(`/api/recommendations/${r.id}/outcome`, body);
      i++; step();
    };
    document.getElementById('skipAll').onclick = () => { setBar(null); done(); };
    window.onkeydown = (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); next.click(); } return; }
      if (/^[1-4]$/.test(e.key)) { e.preventDefault(); pick(OUTCOMES[Number(e.key) - 1][0]); }
      else if (e.key === 'Enter') { e.preventDefault(); next.click(); }
    };
  };
  step();
}
async function followupsPage() {
  const fu = await get('/api/followups');
  if (!fu.length) { app.innerHTML = h`<div class="interview"><div class="q"><div class="eyebrow">What happened</div><div class="text">Nothing waiting. Every pick has an outcome.</div><p class="help"><a class="btn" href="#home">Home</a></p></div></div>`; return; }
  renderFollowups(fu, () => { toast('Thank you. That teaches the tool.'); location.hash = 'home'; });
}

async function renderQuestion(id, nx, mode, reaction) {
  if (nx.needsAnchors) {
    setBar(Math.round(Math.min(96, 4 + (nx.index / Math.max(nx.total, 1)) * 92)));
    app.innerHTML = h`<div class="interview"><div class="q"><div class="eyebrow">Your books</div><div class="text">Reading what you wrote about the books you loved…</div><p class="help"><span class="spinner"></span> &nbsp;One question per book: which part of it did the work?</p></div></div>`;
    const r = await post(`/api/sessions/${id}/anchors`);
    return renderQuestion(id, r.next, mode, '');
  }
  if (nx.needsAdaptive) {
    setBar(88);
    app.innerHTML = h`<div class="interview"><div class="q"><div class="eyebrow">Follow-ups</div><div class="text">Reading your answers…</div><p class="help"><span class="spinner"></span> &nbsp;Two or three sharper questions, written for you.</p></div></div>`;
    const r = await post(`/api/sessions/${id}/adaptive`);
    return renderQuestion(id, r.next, mode, '');
  }
  if (nx.done) { setBar(100); return mode === 'onboarding' ? renderOnboardingDone() : renderSummary(id); }
  const q = nx.question;
  const total = Math.max(nx.total, 1);
  setBar(Math.round(Math.min(96, 4 + (nx.index / total) * 92)));
  const phase = { onboarding: 'About you', anchors: 'Your books', checkin: 'Right now', path: 'The path', gift: 'About them', adaptive: 'A few more' }[nx.phase] || '';
  const isScale = q.type === 'scale', isMulti = q.type === 'multi', isText = q.type === 'text';
  let sel = Array.isArray(q.previous?.answer) ? [...q.previous.answer] : q.previous?.answer != null && !isText ? [q.previous.answer] : [];
  const prevText = q.previous?.text || '';
  app.innerHTML = h`
  <div class="interview"><div class="q">
    <div class="meta"><span class="eyebrow">${phase} · <span class="tabular">${nx.index + 1} of ${total}</span></span><span class="react">${reaction}</span></div>
    <div class="text">${q.text}</div>
    ${q.help ? raw(h`<p class="help">${q.help}</p>`) : ''}
    ${q.previous ? raw(h`<div class="prev">Last time: <b>${(q.previous.labels || []).join(', ')}${q.previous.text ? (q.previous.labels?.length ? ' · ' : '') + q.previous.text : ''}</b>. Press Enter to keep it, or change it.</div>`) : ''}
    ${isText ? raw(h`<textarea id="free" placeholder="${q.placeholder || ''}">${prevText}</textarea>`) : raw(h`
      <div class="opts ${isScale ? 'scale' : ''}">
        ${q.options.map((o, i) => raw(h`<button class="opt ${sel.includes(o.id) ? 'on' : ''} ${q.pair ? 'pair' : ''}" data-id="${o.id}"><span class="kbd">${isScale ? o.id : i + 1}</span><span><span class="l">${q.pair ? o.hint : o.label || (isScale ? '' : o.id)}</span>${!q.pair && o.hint ? raw(h`<span class="h">${o.hint}</span>`) : ''}${q.pair ? raw(h`<span class="h">${o.label}</span>`) : ''}</span><span class="ck">✓</span></button>`))}
      </div>
      ${isScale ? raw(h`<div class="scale-ends"><span>${q.left || ''}</span><span>${q.right || ''}</span></div>`) : ''}
      <div class="other"><button class="btn sm ghost" id="otherBtn">✎ Other / my own words</button><textarea id="free" hidden placeholder="Say it your way. Free text is read as the strongest signal.">${prevText}</textarea></div>`)}
    <div class="qactions">
      <button class="btn primary" id="next">${isMulti ? 'Continue' : isText ? 'Continue' : 'Continue'} <span class="kbd" style="background:transparent;color:inherit;border-color:currentColor;opacity:.7">↵</span></button>
      ${nx.index > 0 ? raw(h`<button class="btn ghost" id="back">← Back</button>`) : ''}
      ${q.required ? '' : raw(h`<button class="btn ghost" id="skip">Skip</button>`)}
      <span class="hint">${isMulti ? 'Pick any that apply, then Continue.' : isText ? 'Ctrl+Enter to continue.' : isScale ? 'Press 1 to 5.' : 'Press a number, or click.'}</span>
    </div>
  </div></div>`;
  const free = document.getElementById('free');
  const otherBtn = document.getElementById('otherBtn');
  if (otherBtn) otherBtn.onclick = () => { free.hidden = !free.hidden; if (!free.hidden) free.focus(); };
  if (prevText && free && otherBtn) free.hidden = false;
  let leaving = false;
  const leave = async (fn) => {
    if (leaving) return; leaving = true;
    const qEl = app.querySelector('.q'); if (qEl) { qEl.classList.add('out'); await new Promise((r) => setTimeout(r, 170)); }
    await fn();
  };
  const submit = (skipped = false) => {
    if (!skipped && q.required && !free?.value.trim() && !sel.length) return toast('This one matters. Please answer it.');
    const payload = { qId: q.id, skipped, answer: skipped ? null : isText ? null : isMulti ? sel : sel[0] ?? null, freeText: skipped ? null : free?.value.trim() || null };
    if (!skipped && !isText && payload.answer == null && !payload.freeText) return toast('Pick an option or write your own.');
    leave(async () => {
      const r = await post(`/api/sessions/${id}/answer`, payload);
      renderQuestion(id, r, mode, skipped ? 'Skipped.' : reactionFor(q, payload.answer, payload.freeText));
    });
  };
  app.querySelectorAll('.opt').forEach((b) => b.onclick = () => {
    const v = b.dataset.id;
    if (isMulti) { sel = sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v]; b.classList.toggle('on'); }
    else { sel = [v]; app.querySelectorAll('.opt').forEach((x) => x.classList.toggle('on', x.dataset.id === v)); if (free.hidden) setTimeout(() => submit(), 400); }
  });
  document.getElementById('next').onclick = () => submit(false);
  const skip = document.getElementById('skip'); if (skip) skip.onclick = () => submit(true);
  const back = document.getElementById('back'); if (back) back.onclick = () => leave(async () => renderQuestion(id, await post(`/api/sessions/${id}/back`), mode, ''));
  window.onkeydown = (e) => {
    if (e.target.tagName === 'TEXTAREA') { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(false); } return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (/^[1-9]$/.test(e.key) && !isText) { const b = app.querySelectorAll('.opt')[Number(e.key) - 1]; if (b) { e.preventDefault(); b.click(); } }
    else if (e.key === 'Enter') { e.preventDefault(); submit(false); }
    else if (e.key === 'Backspace' && back) { e.preventDefault(); back.click(); }
  };
  if (isText) free.focus();
}

function renderOnboardingDone() {
  app.innerHTML = h`<div class="interview"><div class="q"><div class="eyebrow">Taste profile</div><div class="text">Saved. Every answer keeps its date, so when your taste drifts, the old answer stays visible.</div>
    <p class="help">Next: import your reading history, or find a book for tonight.</p>
    <div class="row"><a class="btn primary big" href="#home">Find a book now</a><a class="btn big" href="#history">Import history</a><a class="btn big ghost" href="#profile">See profile</a></div></div></div>`;
}

async function renderSummary(id) {
  const s = await get(`/api/sessions/${id}`);
  const rows = s.answers.filter((a) => !a.skipped && !['onboarding', 'anchors'].includes(a.layer)).map((a) => {
    const opts = a.options || [];
    const ids = Array.isArray(a.answer) ? a.answer : a.answer != null ? [a.answer] : [];
    const labels = ids.map((x) => opts.find((o) => o.id === x)?.label || opts.find((o) => o.id === x)?.hint || x).filter(Boolean);
    return { q: a.question, a: [labels.join(', '), a.free_text].filter(Boolean).join(' · ') };
  });
  app.innerHTML = h`<div class="interview"><div class="q"><div class="eyebrow">That is everything</div><div class="text">Here is what I heard. Ready when you are.</div>
    <p class="help">${s.mode === 'path' ? 'Next I design the arc, think of candidates for every stage, read real reviews on each, and put the books in order with checkpoints and swaps. About six minutes; you can leave the page.' : s.mode === 'gift' ? 'Next I write a brief about them, think of candidates, read real reviews, and choose three to five safe-to-give books. About five minutes.' : 'Next I write a brief, think of 12 to 22 candidates, read real reviews on each, and choose three to five. It takes about five minutes and you can leave the page.'}</p>
    <div class="summary">${rows.map((r) => raw(h`<div class="s"><span class="k">${r.q.replace(/\?$/, '')}</span><span>${r.a}</span></div>`))}</div>
    <div class="qactions"><button class="btn primary big" id="go">${s.mode === 'path' ? 'Build my path' : s.mode === 'gift' ? 'Find the gift' : 'Find my books'}</button><button class="btn ghost" id="back">← Change an answer</button></div></div></div>`;
  document.getElementById('go').onclick = async () => { await post(`/api/sessions/${id}/recommend`); renderProgress(id); };
  document.getElementById('back').onclick = async () => renderQuestion(id, await post(`/api/sessions/${id}/back`), s.mode, '');
  window.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('go').click(); };
}

// ---------- the five-minute job ----------
const STEPS = [['brief', 'Reading your answers', 35], ['candidates', 'Thinking of candidates', 100], ['enrich', 'Fetching real descriptions, ratings and reviews', 25], ['digest', 'Reading the reviews, book by book', 75], ['rank', 'Choosing the slate', 95]];
const WAIT_LINES = ['Librarians call this a readers\' advisory interview. It usually takes a desk and a cup of tea.', 'Ratings cluster between 3.8 and 4.2, so the reviews matter more than the stars.', 'Nearly half of abandoned books are dropped for a slow start. The opening pages get checked.', 'One slot is always a wildcard. You can say no to it.', 'Everything you reject teaches the next session.'];
function renderProgress(id) {
  const log = []; const t0 = Date.now(); const total = STEPS.reduce((a, s) => a + s[2], 0);
  let stepStart = t0; let lineIdx = 0; let timer;
  const draw = () => {
    const current = log.length ? log[log.length - 1].step : 'brief';
    const ci = Math.max(0, STEPS.findIndex((s) => s[0] === current));
    const done = current === 'done';
    const before = STEPS.slice(0, ci).reduce((a, s) => a + s[2], 0);
    const inStep = Math.min(1, (Date.now() - stepStart) / 1000 / STEPS[ci][2]);
    const pct = done ? 100 : Math.min(97, Math.round(((before + inStep * STEPS[ci][2] * 0.95) / total) * 100));
    const leftSec = done ? 0 : Math.max(20, total - before - inStep * STEPS[ci][2]);
    const err = log.find((l) => l.step === 'error');
    const brief = log.find((l) => l.brief)?.brief;
    const cands = log.find((l) => l.candidates)?.candidates;
    app.innerHTML = h`<div class="job">
      <div class="eyebrow">Working on it</div>
      <h2 style="margin-top:8px">${done ? 'Done. Opening your books.' : err ? 'Something went wrong' : STEPS[ci][1] + '…'}</h2>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="pct"><span class="tabular">${pct}%</span><span>${done ? '' : err ? '' : leftSec > 90 ? `About ${Math.ceil(leftSec / 60)} minutes left` : 'Under two minutes left'}</span></div>
      ${err ? raw(h`<p style="color:var(--danger);margin-top:16px">${err.msg}</p><p style="margin-top:12px"><button class="btn primary" id="retry">Try again</button></p>`) : ''}
      <ul class="steps">${STEPS.map(([k, label], i) => {
        const msgs = log.filter((l) => l.step === k);
        const state = done || i < ci ? 'done' : i === ci ? 'active' : 'todo';
        const sub = msgs.length ? msgs[msgs.length - 1].msg : '';
        return raw(h`<li class="${state}"><span class="ico">${state === 'done' ? '✓' : state === 'active' ? raw('<span class="spinner"></span>') : ''}</span><span>${label}${sub && state !== 'todo' ? raw(h`<span class="sub">${sub}${(k === 'enrich' || k === 'digest') && msgs.length > 1 ? ` (${msgs.length - 1} so far)` : ''}</span>`) : ''}</span></li>`);
      })}</ul>
      ${brief ? raw(h`<div class="section" style="margin-top:24px"><div class="eyebrow">How I read you</div><p class="readernow" style="margin-top:12px">${brief.reader_now}</p></div>`) : ''}
      ${cands ? raw(h`<details><summary>Long list (${cands.length})</summary><p class="cap sec">${cands.join(' · ')}</p></details>`) : ''}
      ${!done && !err ? raw(h`<p class="wait">${WAIT_LINES[lineIdx % WAIT_LINES.length]}</p>`) : ''}
    </div>`;
    const retry = document.getElementById('retry'); if (retry) retry.onclick = async () => { await post(`/api/sessions/${id}/recommend`); renderProgress(id); };
  };
  draw();
  clearInterval(renderProgress.timer);
  timer = renderProgress.timer = setInterval(() => { if (!location.hash.includes(`/${id}`)) return clearInterval(timer); if ((Date.now() - t0) % 12000 < 1000) lineIdx++; draw(); }, 1000);
  const es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.step === 'idle') { es.close(); clearInterval(timer); return get(`/api/sessions/${id}`).then((s) => (s.status === 'recommended' ? (location.hash = `results/${id}`) : interview(id))); }
    const prevStep = log.length ? log[log.length - 1].step : null;
    log.push(ev); if (ev.step !== prevStep) stepStart = Date.now(); draw();
    if (ev.step === 'done') { es.close(); clearInterval(timer); setTimeout(() => (location.hash = `results/${id}`), 600); }
    if (ev.step === 'error') { es.close(); clearInterval(timer); }
  };
  es.onerror = () => { es.close(); setTimeout(() => get(`/api/sessions/${id}`).then((s) => (s.status === 'recommended' ? (location.hash = `results/${id}`) : s.running ? renderProgress(id) : null)), 2000); };
}

// ---------- results ----------
async function results(id) {
  const s = await get(`/api/sessions/${id}`);
  if (s.status !== 'recommended') return interview(id);
  const shelves = await get('/api/shelves');
  const picks = s.recommendations.filter((r) => r.fit?.kind === 'pick');
  const runners = s.recommendations.filter((r) => r.fit?.kind === 'runner_up');
  const b = s.brief || {};
  const isPath = s.mode === 'path', isGift = s.mode === 'gift';
  const who = isGift ? (s.answers.find((a) => a.q_id === 'gift_who')?.free_text || 'them') : null;
  app.innerHTML = h`
  <section class="section" style="padding-top:8px">
    <div class="eyebrow">${when(s.started_at)} · ${isPath ? 'the arc' : isGift ? `a gift for ${who}` : 'how I read you'}</div>
    <p class="readernow" style="margin-top:12px">${b.reader_now || s.summary || ''}</p>
    ${b.note_to_reader ? raw(h`<p class="note" style="margin-top:16px">${b.note_to_reader}</p>`) : ''}
    <details><summary>The brief</summary><dl class="facts">
      <dt>Need</dt><dd>${b.need}</dd><dt>Pace</dt><dd>${b.appeal_targets?.pace}</dd><dt>Tone</dt><dd>${(b.appeal_targets?.tone || []).join(', ')}</dd>
      <dt>Style</dt><dd>${(b.appeal_targets?.style || []).join(', ')}</dd><dt>Moods</dt><dd>${(b.appeal_targets?.moods || []).join(', ')}</dd><dt>Doorway</dt><dd>${b.appeal_targets?.doorway}</dd>
      <dt>Hard excludes</dt><dd>${(b.hard_excludes || []).join(', ') || 'none'}</dd><dt>Soft avoid</dt><dd>${(b.soft_avoid || []).join(', ') || 'none'}</dd><dt>Slots</dt><dd>${(b.slots || []).join(' · ')}</dd></dl>
      ${b.dropped?.length ? raw(h`<div class="cap sec" style="margin-top:12px"><b>Dropped after reading reviews:</b> ${b.dropped.map((d) => `${d.title}: ${d.reason}`).join(' · ')}</div>`) : ''}
    </details>
  </section>
  <section class="section">
    <div class="row between" style="margin-bottom:20px"><div class="eyebrow">${isPath ? `Your path: ${picks.length} books` : isGift ? `${picks.length} gifts to choose from` : `Your ${picks.length} picks`}</div><div class="row noprint"><button class="btn sm" id="slateChatBtn">Ask about these picks</button><button class="btn sm" id="copyMd">Copy as text</button><a class="btn sm" href="/api/sessions/${id}/export?download=1">Download .md</a><button class="btn sm ghost" id="printBtn">Print</button></div></div>
    <div id="slateChat" hidden style="margin-bottom:24px">${chatPanel({ sessionId: id, starters: ['Which one should I start tonight?', 'Compare the top two for me', 'Why nothing lighter / funnier?', 'Which is best as an audiobook?', 'What would a Polish reader get here?'] })}</div>
    ${isPath ? raw(h`<div class="pathline">${picks.map((r, i) => pathStage(r, i, b, shelves, id))}</div>`) : raw(h`<div class="picks">${picks.map((r) => pickCard(r, shelves, id, isGift ? who : null))}</div>`)}</section>
  ${runners.length ? raw(h`<section class="section"><div class="eyebrow">Also considered</div>${runners.map((r) => raw(h`<div class="runner">${coverImg(r.cover, r.title)}<div><div class="ttl"><a href="#book/${r.book_id}" style="color:inherit">${r.title}</a></div><div class="by">${r.author} · ${r.year || ''}</div><p style="margin-top:6px;font-size:17px">${r.fit.one_line}</p><div class="actions" style="border:0;padding-top:10px;margin-top:6px">${shelfMenu(r, shelves)}<span class="saved" data-saved="${r.id}">${r.feedback ? labelFeedback(r.feedback) : ''}</span></div></div></div>`))}</section>`) : ''}
  <section class="section row"><a class="btn" href="#home">New search</a><button class="btn" id="again">Same answers, different picks</button><span class="cap sec">Re-runs the research excluding everything shown here.</span></section>`;
  wireShelfButtons();
  wireChats();
  document.getElementById('slateChatBtn').onclick = () => { const el = document.getElementById('slateChat'); el.hidden = !el.hidden; if (!el.hidden) el.querySelector('textarea')?.focus(); };
  document.getElementById('copyMd').onclick = async () => { const t = await (await fetch(`/api/sessions/${id}/export`)).text(); try { await navigator.clipboard.writeText(t); toast('Copied the slate as text'); } catch { toast('Could not copy; use Download instead'); } };
  document.getElementById('printBtn').onclick = () => window.print();
  document.getElementById('again').onclick = async () => {
    for (const r of s.recommendations) if (!r.feedback) await post(`/api/recommendations/${r.id}/feedback`, { feedback: 'not_now' });
    await post(`/api/sessions/${id}/recommend`); renderProgress(id);
  };
}

function pathStage(r, i, b, shelves, sessionId) {
  const stage = (b.stages || [])[i] || {};
  const f = r.fit;
  return raw(h`<div class="stage">
    <div class="stagemark"><span class="num tabular">${i + 1}</span><span class="line"></span></div>
    <div class="stagebody">
      <div class="stagehead"><span class="eyebrow">Stage ${i + 1}${stage.weeks ? ` · about ${stage.weeks} ${stage.weeks === 1 ? 'week' : 'weeks'}` : ''}</span>${stage.from_state ? raw(h`<span class="cap sec">${stage.from_state} → ${stage.to_state}</span>`) : ''}</div>
      ${pickCard(r, shelves, sessionId, null, true)}
      ${f.checkpoint ? raw(h`<div class="checkpoint"><b>Checkpoint.</b> ${f.checkpoint}${f.alternate ? raw(h` <span class="alt">Swap: <a href="#book/${f.alternate.book_id}">${f.alternate.title}</a> (${f.alternate.author})${f.alternate.when ? `, ${f.alternate.when}` : ''}.</span>`) : ''}</div>`) : ''}
      ${f.transition ? raw(h`<p class="transition">${f.transition}</p>`) : ''}
    </div></div>`);
}
const GET_LINKS = (r) => {
  const q = encodeURIComponent(`${r.title} ${r.author || ''}`);
  const pl = r.extra?.lubimyczytac;
  return [
    r.url ? ['Goodreads', r.url] : null,
    ['Google Books', `https://www.google.com/books/feeds/volumes?q=${q}`.replace('/books/feeds/volumes?q=', '/search?tbm=bks&q=')],
    ['Open Library', `https://openlibrary.org/search?q=${q}`],
    ['StoryGraph', `https://app.thestorygraph.com/browse?search_term=${q}`],
    ['Libby / OverDrive', `https://www.overdrive.com/search?q=${q}`],
    ['Audible', `https://www.audible.com/search?keywords=${q}`],
    pl ? ['lubimyczytac.pl', pl.url] : ['lubimyczytac.pl', `https://lubimyczytac.pl/szukaj/ksiazki?phrase=${q}`],
    ['Legimi', `https://www.legimi.pl/szukaj/?q=${encodeURIComponent(pl?.polishTitle || r.title)}`],
    ['Empik', `https://www.empik.com/szukaj/produkt?q=${encodeURIComponent(pl?.polishTitle || r.title)}`],
  ].filter(Boolean);
};
function getLinks(r) {
  const pl = r.extra?.lubimyczytac;
  return raw(h`<details class="noprint"><summary>Where to get it</summary>
    ${pl ? raw(h`<p class="cap">Polish edition: <b>${pl.polishTitle}</b>${pl.translator ? `, translated by ${pl.translator}` : ''}${pl.rating10 ? `, ${pl.rating10}/10 on lubimyczytac.pl` : ''}${pl.audiobook ? ', audiobook exists' : ''}.</p>`) : r.extra?.polishChecked ? raw('<p class="cap sec">No Polish edition found on lubimyczytac.pl.</p>') : ''}
    <div class="links">${GET_LINKS(r).map(([n, u]) => raw(h`<a class="chip" href="${u}" target="_blank" rel="noopener">${n} ↗</a>`))}</div></details>`);
}
function pickCard(r, shelves, sessionId, giftFor = null, inPath = false) {
  const f = r.fit; const d = r.review_digest;
  const chips = [d?.appeal?.pace, ...(d?.appeal?.moods || [])].filter(Boolean).slice(0, 3);
  return raw(h`<article class="card pick" data-rec="${r.id}">
    <a href="#book/${r.book_id}">${coverImg(r.cover, r.title)}</a>
    <div>
      <div class="head">${inPath ? '' : raw(h`<span class="chip amber">${(f.slot || '').replace(/_/g, ' ')}</span>`)}${f.reread ? raw('<span class="chip lamp">a reread</span>') : ''}${rating(r.rating, r.ratings_count)}</div>
      <div class="ttl"><a href="#book/${r.book_id}">${r.title}</a></div>
      <div class="by">${r.author} · ${r.year || ''}${r.pages ? ` · ${r.pages} pages` : ''}${d?.polarising ? ' · polarising' : ''}</div>
      <div class="row" style="gap:6px">${chips.map((c) => raw(h`<span class="chip">${c}</span>`))}</div>
      <div class="hl">${f.headline}</div>
      <p class="why">${f.why_now}</p>
      <dl class="facts">
        <dt>Readers love</dt><dd>${f.what_readers_love}</dd>
        <dt>Readers complain</dt><dd>${f.what_readers_complain}</dd>
        <dt>Risk for you</dt><dd>${f.risk_for_you}</dd>
        <dt>The opening</dt><dd>${f.first_pages}</dd>
        <dt>Read if</dt><dd>${f.read_if}</dd>
        <dt>Skip if</dt><dd>${f.skip_if}</dd>
        ${f.audio_note ? raw(h`<dt>As audio</dt><dd>${f.audio_note}</dd>`) : ''}
      </dl>
      ${d?.quotes?.length ? raw(h`<details><summary>What readers actually wrote</summary>${d.quotes.map((q) => raw(h`<div class="quote">“${q}”</div>`))}${d.content_notes?.length ? raw(h`<div class="cap sec">Content notes: ${d.content_notes.join(', ')}</div>`) : ''}</details>`) : ''}
      <details><summary>Description</summary><p class="prose" style="font-size:17px">${(r.description || '').slice(0, 1200)}</p><p class="cap"><a href="${r.url}" target="_blank" rel="noopener">Open on Goodreads ↗</a></p></details>
      ${getLinks(r)}
      <div class="actions">${giftFor ? raw(h`<button class="btn sm primary" data-shelf="Gifts" data-rec="${r.id}" data-ask="Who is it for, and any note?" data-prefill="For ${giftFor}">Choose as the gift</button><button class="btn sm ghost" data-shelf="Not for me" data-rec="${r.id}" data-ask="Why not for them? One line.">Not for them</button>`) : shelfMenu(r, shelves)}<span class="saved" data-saved="${r.id}">${r.feedback ? labelFeedback(r.feedback) : ''}</span></div>
      <div class="actions noprint" style="border:0;padding-top:8px;margin-top:4px"><button class="btn sm" data-chattoggle="chat-${r.book_id}">Ask about this book</button></div>
      <div id="chat-${r.book_id}" hidden>${chatPanel({ bookId: r.book_id, sessionId, starters: ['How slow is the opening, honestly?', 'How dark does it get?', 'Anything in it that would bother me?', 'What is it actually about, no spoilers?', 'Why this over the runners-up?', 'Is there a Polish edition or a good audiobook?'] })}</div>
    </div></article>`);
}

// ---------- chat panel ----------
function chatPanel({ bookId = null, sessionId = null, starters = [] }) {
  return raw(h`<div class="chat" data-chat data-book="${bookId || ''}" data-session="${sessionId || ''}">
    <div class="msgs"></div>
    <div class="starters">${starters.map((s) => raw(h`<button class="chip" data-starter>${s}</button>`))}</div>
    <form class="askrow"><textarea rows="1" placeholder="Ask anything about ${bookId ? 'this book' : 'these picks'}: pace, darkness, spoilers on request, editions, comparisons…"></textarea><button class="btn primary" type="submit">Ask</button></form>
    <div class="cap sec chatfoot">Answers use the real reviews and your profile. <button class="linkbtn" data-clear>Clear conversation</button></div>
  </div>`);
}
function wireChats() {
  app.querySelectorAll('[data-chattoggle]').forEach((b) => b.onclick = () => { const el = document.getElementById(b.dataset.chattoggle); el.hidden = !el.hidden; if (!el.hidden) el.querySelector('textarea').focus(); });
  app.querySelectorAll('[data-chat]').forEach(async (el) => {
    const bookId = Number(el.dataset.book) || null, sessionId = Number(el.dataset.session) || null;
    const msgs = el.querySelector('.msgs'), form = el.querySelector('form'), ta = el.querySelector('textarea'), starters = el.querySelector('.starters');
    let chatId = null; let busy = false;
    const bubble = (role, html) => { const d = document.createElement('div'); d.className = `msg ${role}`; d.innerHTML = html; msgs.appendChild(d); return d; };
    const paint = (c) => { chatId = c?.id || null; msgs.innerHTML = ''; for (const m of c?.messages || []) bubble(m.role, m.role === 'user' ? esc(m.text) : md(m.text)); starters.hidden = !!(c?.messages?.length); };
    try { paint(await get(`/api/chat?bookId=${bookId || ''}&sessionId=${sessionId || ''}`)); } catch {}
    const send = async (text) => {
      if (!text.trim() || busy) return; busy = true; ta.value = ''; ta.style.height = '';
      starters.hidden = true;
      bubble('user', esc(text));
      const a = bubble('assistant', '<span class="spinner"></span>'); let acc = ''; let tools = 0;
      a.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      try {
        const page = Number(document.getElementById('pageIn')?.value) || null;
        await streamPost('/api/chat', { bookId, sessionId, message: text, page }, (ev) => {
          if (ev.type === 'delta') { acc += ev.text; a.innerHTML = md(acc) + '<span class="cursor"></span>'; }
          else if (ev.type === 'tool') { tools++; a.innerHTML = (acc ? md(acc) : '') + `<p class="cap sec"><span class="spinner"></span> Looking it up (${ev.name === 'WebSearch' ? 'search' : 'web'})…</p>`; }
          else if (ev.type === 'done') { paint(ev.chat); }
          else if (ev.type === 'error') { a.innerHTML = `<p style="color:var(--danger)">${esc(ev.message)}</p>`; }
        });
      } catch (e) { a.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
      busy = false; ta.focus();
    };
    form.onsubmit = (e) => { e.preventDefault(); send(ta.value); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); } };
    ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
    el.querySelectorAll('[data-starter]').forEach((b) => b.onclick = () => send(b.textContent));
    el.querySelector('[data-clear]').onclick = async () => { if (chatId) await del(`/api/chat/${chatId}`); paint(null); };
  });
}

// ---------- "Should I read this?" ----------
const VERDICT_LABEL = { yes: 'Yes', probably: 'Probably', maybe: 'Maybe', probably_not: 'Probably not', no: 'No' };
const verdictLabel = (v) => VERDICT_LABEL[v] || '';
async function check(q = '') {
  q = decodeURIComponent(q);
  app.innerHTML = h`<section class="section" style="padding-top:8px"><div class="eyebrow">Should I read this?</div><h1 style="margin-top:8px">Check one book against your taste</h1>
    <p class="sec" style="margin-top:12px;max-width:62ch">Type a title. The tool fetches its real reviews, reads them, and judges the book against everything it knows about you, including your latest mood check-in. About a minute.</p>
    <form class="row" id="f" style="margin-top:16px"><input type="text" id="q" value="${q}" placeholder="Title and author" style="flex:1;min-width:220px" autocomplete="off"><button class="btn primary">Search</button></form>
    <div id="res" style="margin-top:16px"></div></section>`;
  const res = document.getElementById('res'); const input = document.getElementById('q');
  const search = async () => {
    const v = input.value.trim(); if (!v) return;
    res.innerHTML = '<p class="cap sec"><span class="spinner"></span> Searching Goodreads…</p>';
    let hits = []; try { hits = await get(`/api/books/search?q=${encodeURIComponent(v)}`); } catch (e) { res.innerHTML = h`<p style="color:var(--danger)">${e.message}</p>`; return; }
    res.innerHTML = hits.length ? hits.map((r) => h`<div class="runner">${coverImg(r.cover, r.title)}<div><div class="ttl">${r.title}</div><div class="by">${r.author} · ${r.year || ''} ${rating(r.rating, r.ratingsCount)}</div><p style="margin-top:8px"><button class="btn sm primary" data-gid="${r.goodreadsId}">Should I read this?</button></p></div></div>`).join('') : '<p class="cap sec">Nothing found. Try the title alone, or the original title.</p>';
    res.querySelectorAll('[data-gid]').forEach((b) => b.onclick = async () => {
      res.querySelectorAll('button').forEach((x) => (x.disabled = true));
      const status = document.createElement('div'); status.className = 'checking'; status.innerHTML = '<span class="spinner"></span> Fetching the real reviews…'; b.closest('.runner').appendChild(status);
      try {
        const bk = await post('/api/books/import', { goodreadsId: b.dataset.gid });
        if (!bk.review_digest) { status.innerHTML = '<span class="spinner"></span> Reading what readers wrote…'; await post(`/api/books/${bk.id}/digest`); }
        status.innerHTML = '<span class="spinner"></span> Judging it against your profile (the best model, about a minute)…';
        await post(`/api/books/${bk.id}/verdict`);
        location.hash = `book/${bk.id}`;
      } catch (e) { status.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; res.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
    });
  };
  document.getElementById('f').onsubmit = (e) => { e.preventDefault(); search(); };
  if (q) search(); else input.focus();
}
function authorList(a) {
  return raw(h`<p class="prose" style="margin-top:8px">${a.note}</p><div class="authorlist">${(a.books || []).map((x) => raw(h`<div class="arow"><div><b>${x.title}</b> <span class="cap sec">${x.year || ''} · ${x.kind}</span><div style="font-size:16px;margin-top:2px">${x.why_for_you}</div>${x.caution ? raw(h`<div class="cap sec">Caution: ${x.caution}</div>`) : ''}</div><div class="fitnum"><span class="tabular">${x.fit}</span>%<a class="btn sm" href="#check/${encodeURIComponent(x.title)}">Check</a></div></div>`))}</div><p class="cap sec" style="margin-top:6px">Ranked ${when(a.at)}.</p>`);
}
function verdictBlock(v, when_) {
  const tone = ['yes', 'probably'].includes(v.verdict) ? 'good' : v.verdict === 'maybe' ? 'mid' : 'bad';
  return raw(h`<div class="verdict ${tone}">
    <div class="vhead"><span class="vword">${verdictLabel(v.verdict)}</span><span class="vfit"><span class="tabular">${v.fit}</span>% fit</span>${when_ ? raw(h`<span class="cap sec">judged ${when(when_)}</span>`) : ''}</div>
    <div class="hl" style="margin-top:6px">${v.headline}</div>
    <p class="prose" style="margin-top:10px">${v.why}</p>
    <dl class="facts">
      <dt>You will love</dt><dd>${v.you_will_love}</dd>
      <dt>Will bother you</dt><dd>${v.will_bother_you}</dd>
      <dt>Biggest risk</dt><dd>${v.biggest_risk}</dd>
      <dt>Best moment</dt><dd>${v.best_moment}</dd>
      <dt>Not now if</dt><dd>${v.not_now_if}</dd>
      <dt>The opening</dt><dd>${v.first_pages}</dd>
      ${v.audio_note ? raw(h`<dt>As audio</dt><dd>${v.audio_note}</dd>`) : ''}
      ${v.alternatives?.length ? raw(h`<dt>Instead, maybe</dt><dd>${v.alternatives.map((a) => raw(h`<div><b>${a.title}</b> (${a.author}): ${a.why}</div>`))}<div class="cap sec" style="margin-top:4px">Unverified suggestions; check them with the search above.</div></dd>`) : ''}
    </dl>
  </div>`);
}
const labelFeedback = (f) => ({ saved: 'Saved', not_now: 'Not now', not_for_me: 'Not for me', already_read: 'Already read', started: 'Reading now', finished: 'Finished', dropped: 'Dropped', later: 'Up next' }[f] || f);
function shelfMenu(r, shelves) {
  return raw(h`${['Up next', 'Someday', 'Maybe'].map((n) => raw(h`<button class="btn sm" data-shelf="${n}" data-rec="${r.id}">${n}</button>`))}
    <button class="btn sm" data-shelf="Reading now" data-rec="${r.id}">Reading now</button>
    <button class="btn sm ghost" data-shelf="Not for me" data-rec="${r.id}" data-ask="Why not? One line teaches the tool.">Not for me</button>
    <button class="btn sm ghost" data-shelf="Finished" data-rec="${r.id}" data-ask="Already read it. What did you think?">Already read</button>
    <select class="btn sm" data-custom="${r.id}" style="width:auto"><option value="">More shelves…</option>${shelves.filter((s) => s.kind === 'custom').map((s) => raw(h`<option value="${s.name}">${s.name}</option>`))}<option value="__new">+ New shelf</option></select>`);
}
function wireShelfButtons() {
  app.querySelectorAll('[data-shelf]').forEach((b) => b.onclick = async () => {
    const shelf = b.dataset.shelf; let note = null;
    if (b.dataset.ask) { note = prompt(b.dataset.ask, b.dataset.prefill || ''); if (note === null) return; }
    const fb = shelf === 'Not for me' ? 'not_for_me' : shelf === 'Finished' ? 'already_read' : shelf === 'Reading now' ? 'started' : 'saved';
    await post(`/api/recommendations/${b.dataset.rec}/feedback`, { feedback: fb, note, shelf });
    const el = app.querySelector(`[data-saved="${b.dataset.rec}"]`); if (el) el.textContent = `✓ ${shelf}`;
    toast(`Saved to ${shelf}`);
  });
  app.querySelectorAll('[data-custom]').forEach((sel) => sel.onchange = async () => {
    let name = sel.value; if (!name) return;
    if (name === '__new') { name = prompt('New shelf name (for example "Beach", "For when sad", "Gifts")'); if (!name) return (sel.value = ''); await post('/api/shelves', { name }); }
    await post(`/api/recommendations/${sel.dataset.custom}/feedback`, { feedback: 'saved', shelf: name });
    const el = app.querySelector(`[data-saved="${sel.dataset.custom}"]`); if (el) el.textContent = `✓ ${name}`;
    toast(`Saved to ${name}`); sel.value = '';
  });
}

// ---------- book detail ----------
async function book(id) {
  const b = await get(`/api/books/${id}`);
  const shelves = await get('/api/shelves');
  const vd = await get(`/api/books/${id}/verdict`);
  const d = b.review_digest;
  const total = b.rating_dist ? b.rating_dist.reduce((a, c) => a + c, 0) : 0;
  app.innerHTML = h`<article class="pick section" style="padding-top:8px">
    <div>${coverImg(b.cover, b.title)}</div>
    <div>
      <h1 style="font-family:var(--reading);font-size:32px">${b.title}</h1>
      <div class="by" style="font-size:17px">${b.author} · ${b.year || ''}${b.pages ? ` · ${b.pages} pages` : ''}${b.language ? ` · ${b.language}` : ''}</div>
      <div class="row" style="margin-top:8px">${rating(b.rating, b.ratings_count)}${b.rating_dist ? raw(h`<span class="dist" title="Rating spread, 1 to 5 stars">${b.rating_dist.map((n) => raw(h`<span style="height:${Math.max(2, Math.round((n / Math.max(...b.rating_dist)) * 28))}px" title="${Math.round((n / total) * 100)}%"></span>`))}</span>`) : ''}</div>
      <div class="row" style="gap:6px;margin-top:10px">${b.genres.slice(0, 6).map((g) => raw(h`<span class="chip">${g}</span>`))}</div>
      ${b.extra?.awards?.length ? raw(h`<p class="cap sec" style="margin-top:10px">${b.extra.awards.join(' · ')}</p>`) : ''}
      ${b.extra?.lubimyczytac ? raw(h`<p class="cap sec" style="margin-top:6px">Polish edition “${b.extra.lubimyczytac.polishTitle}”: ${b.extra.lubimyczytac.rating10}/10 from ${fmtN(b.extra.lubimyczytac.ratingsCount)} readers on lubimyczytac.pl</p>`) : ''}
      <p class="prose" style="margin-top:16px">${b.description}</p>
      <p class="cap" style="margin-top:8px"><a href="${b.url}" target="_blank" rel="noopener">Open on Goodreads ↗</a></p>
      ${getLinks(b)}<p class="cap noprint" style="margin-top:6px"><button class="linkbtn" id="plCheck">${b.extra?.lubimyczytac ? 'Re-check the Polish edition' : 'Check for a Polish edition and audiobook'}</button></p>
      <div class="actions">${['Reading now', 'Up next', 'Someday', 'Maybe', 'Finished', 'Did not finish', 'Not for me'].map((n) => raw(h`<button class="btn sm" data-add="${n}">${n}</button>`))}<span class="cap sec">On: ${b.shelves.map((s) => s.name).join(', ') || 'no shelf yet'}</span></div>
    </div></article>
  <section class="section"><div class="row between"><h2>Reading it?</h2><div class="row"><label class="cap sec" for="pageIn">I am on page</label><input type="number" id="pageIn" min="0" value="${b.progress || ''}" style="width:110px" placeholder="${b.pages ? 'of ' + b.pages : ''}"><button class="btn sm" id="pageSave">Save</button></div></div>
    <p class="cap sec" style="margin-top:6px">With a page set, the conversation below keeps everything after it secret, and "is it worth continuing?" gets an honest answer from the later reviews and your own history of dropping books.</p>
    <div style="margin-top:16px"><label class="lbl">A line you underlined, or a note while reading</label><div class="row"><textarea id="noteText" rows="2" style="flex:1;min-width:240px" placeholder="Paste or type the sentence. What you underline says more about your taste than any rating."></textarea><input type="number" id="notePage" min="0" style="width:90px" placeholder="page"><button class="btn sm" id="noteSave">Keep it</button></div></div>
    ${b.notes?.length ? raw(h`<div class="notes">${b.notes.map((n) => raw(h`<div class="quote">“${n.text}”<span class="cap sec"> ${n.page ? `p. ${n.page} · ` : ''}${when(n.created_at)} · <a href="#" data-delnote="${n.id}">delete</a></span></div>`))}</div>`) : ''}
  </section>
  <section class="section"><div class="row between"><h2>Should you read it?</h2><button class="btn sm ${vd.verdict ? '' : 'primary'}" id="verdictBtn">${vd.verdict ? 'Judge again' : 'Should I read this?'}</button></div>
    ${vd.verdict ? verdictBlock(vd.verdict, vd.created_at) : raw(h`<p class="sec" style="margin-top:8px;max-width:62ch">The best-tier model reads the reviews and your whole profile, including your latest check-in, and gives an honest verdict with the biggest risk and the best moment to read it.</p>`)}
    <div id="verdictStatus" class="cap sec" style="margin-top:8px"></div></section>
  <section class="section"><h2>Ask about this book</h2><p class="cap sec" style="margin-top:4px">Pace, darkness, what happens in the first 50 pages, comparisons, editions, the audiobook. Spoilers only when you ask for them.</p>
    <div style="margin-top:12px">${chatPanel({ bookId: b.id, starters: b.progress ? ['Is it worth continuing from here?', 'What should I pay attention to next?', 'Does it change after this point?', 'Remind me who is who, no spoilers past my page', 'Permission to quit?'] : ['How slow is the opening, honestly?', 'How dark does it get?', 'Anything in it that would bother me?', 'What is it about, no spoilers?', 'Is there a Polish edition or a good audiobook?', 'What do I read after it?'] })}</div></section>
  <section class="section"><div class="row between"><h2>More by ${b.author || 'this author'}</h2><button class="btn sm ${b.extra?.author_next ? '' : 'primary'}" id="authorBtn">${b.extra?.author_next ? 'Rank again' : 'Which one next?'}</button></div>
    <div id="authorOut">${b.extra?.author_next ? authorList(b.extra.author_next) : raw(h`<p class="sec" style="margin-top:8px;max-width:62ch">Ranks the author's other books for you, from your profile and how this one went. Unverified titles; check any with the search page.</p>`)}</div></section>
  <section class="section"><h2>What real readers say</h2>
    ${d ? raw(h`<p style="margin-top:12px;font-size:20px" class="prose">${d.one_line}</p><dl class="facts"><dt>Praise</dt><dd>${d.praise.map((p) => raw(h`${p}<br>`))}</dd><dt>Complaints</dt><dd>${d.complaints.map((p) => raw(h`${p}<br>`))}</dd><dt>Who loves it</dt><dd>${d.who_loves_it}</dd><dt>Who should skip</dt><dd>${d.who_should_skip}</dd><dt>First 100 pages</dt><dd>${d.first_100_pages}</dd><dt>Content notes</dt><dd>${d.content_notes.join(', ') || 'none noted'}</dd><dt>Appeal</dt><dd><span class="row" style="gap:6px">${[d.appeal.pace, ...d.appeal.tone, ...d.appeal.style, ...d.appeal.moods].filter(Boolean).slice(0, 10).map((t) => raw(h`<span class="chip">${t}</span>`))}</span></dd></dl>${d.quotes.map((q) => raw(h`<div class="quote">“${q}”</div>`))}`) : raw(h`<p class="sec" style="margin-top:8px">No digest yet.</p><p style="margin-top:12px"><button class="btn" id="digest">Read the reviews now</button></p>`)}
    <details><summary>${b.reviews.length} real reviews, most liked first</summary>${b.reviews.slice(0, 15).map((r) => raw(h`<div class="review"><div class="m">${r.rating ? '★ ' + r.rating : ''} · ${r.likes} likes · ${r.createdAt || ''}${r.source === 'lubimyczytac' ? ' · lubimyczytac.pl' : ''}</div>${r.text.slice(0, 1200)}</div>`))}</details>
  </section>`;
  app.querySelectorAll('[data-add]').forEach((btn) => btn.onclick = async () => {
    const shelf = shelves.find((s) => s.name === btn.dataset.add);
    let note = null; if (['Not for me', 'Did not finish'].includes(shelf.name)) { note = prompt('Why? One line helps the tool learn.'); if (note === null) return; }
    await post(`/api/shelves/${shelf.id}/items`, { bookId: b.id, note }); toast(`Added to ${shelf.name}`); book(id);
  });
  const dg = document.getElementById('digest'); if (dg) dg.onclick = async () => { dg.disabled = true; dg.textContent = 'Reading…'; await post(`/api/books/${id}/digest`); book(id); };
  document.getElementById('pageSave').onclick = async () => {
    const page = Number(document.getElementById('pageIn').value) || 0;
    let item = (await get(`/api/shelves`)).find((x) => x.name === 'Reading now');
    const items = await get(`/api/shelves/${item.id}/items`); let it = items.find((x) => x.book_id === b.id);
    if (!it) { await post(`/api/shelves/${item.id}/items`, { bookId: b.id }); it = (await get(`/api/shelves/${item.id}/items`)).find((x) => x.book_id === b.id); }
    await patch(`/api/shelf-items/${it.id}`, { page }); toast(page ? `Page ${page} saved` : 'Progress cleared'); book(id);
  };
  document.getElementById('noteSave').onclick = async () => { const text = document.getElementById('noteText').value.trim(); if (!text) return; await post('/api/notes', { bookId: b.id, text, page: Number(document.getElementById('notePage').value) || null }); toast('Kept'); book(id); };
  app.querySelectorAll('[data-delnote]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); await del(`/api/notes/${a.dataset.delnote}`); book(id); });
  document.getElementById('plCheck').onclick = async (e) => { e.target.textContent = 'Checking lubimyczytac.pl…'; try { await post(`/api/books/${id}/polish`); } catch (err) { toast(err.message); } book(id); };
  document.getElementById('authorBtn').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Thinking…'; try { const r = await post(`/api/books/${id}/author-next`, { force: !!b.extra?.author_next }); document.getElementById('authorOut').innerHTML = render(authorList(r)); } catch (err) { toast(err.message); } e.target.disabled = false; e.target.textContent = 'Rank again'; };
  const vb = document.getElementById('verdictBtn'); vb.onclick = async () => {
    vb.disabled = true; const st = document.getElementById('verdictStatus');
    try { if (!d) { st.innerHTML = '<span class="spinner"></span> Reading the reviews first…'; await post(`/api/books/${id}/digest`); } st.innerHTML = '<span class="spinner"></span> Judging it against your profile, about a minute…'; await post(`/api/books/${id}/verdict`); book(id); }
    catch (e) { st.textContent = e.message; vb.disabled = false; }
  };
  wireChats();
}

// ---------- shelves ----------
async function shelves(activeId) {
  const list = await get('/api/shelves');
  const active = list.find((s) => String(s.id) === String(activeId)) || list[0];
  const items = active ? await get(`/api/shelves/${active.id}/items`) : [];
  const verdictShelf = ['Finished', 'Did not finish'].includes(active?.name);
  app.innerHTML = h`<section class="section" style="padding-top:8px">
    <div class="row between"><h1>Shelves</h1><div class="row"><button class="btn sm" id="newShelf">+ New shelf</button><button class="btn sm" id="addBook">+ Add a book</button></div></div>
    <div class="shelfnav">${list.map((s) => raw(h`<a class="btn sm ${s.id === active?.id ? 'on' : ''}" href="#shelves/${s.id}">${s.name} <span class="tabular sec">${s.count}</span></a>`))}</div>
    ${active ? raw(h`<p class="cap sec">${active.description || ''} ${active.kind === 'custom' ? raw(h`<button class="btn sm ghost" id="delShelf">Delete shelf</button>`) : ''}</p>`) : ''}
    <div id="search" hidden style="margin-top:16px"><input type="text" id="q" placeholder="Title and author, then Enter (searches Goodreads)"><div id="sres"></div></div>
    <div class="items" style="margin-top:16px">${items.length ? items.map((it) => raw(h`<div class="item" data-item="${it.id}">
        <a href="#book/${it.book_id}">${coverImg(it.cover, it.title)}</a>
        <div><div class="ttl"><a href="#book/${it.book_id}" style="color:inherit">${it.title}</a></div><div class="by">${it.author} · ${it.year || ''}${it.pages ? ` · ${it.pages} pages` : ''} · added ${when(it.added_at)}</div>
          <label class="lbl">Note: why it is here, or for which mood</label><input type="text" class="note" value="${it.note || ''}" placeholder="for a rainy weekend; recommended for the sit-with-it mood">
          ${verdictShelf ? raw(h`
            <label class="lbl">${active.name === 'Finished' ? 'Your rating' : 'How far did you get, and why did you stop?'}</label>
            ${active.name === 'Finished' ? raw(h`<div class="rating-input" data-r="${it.my_rating || 0}">${[1, 2, 3, 4, 5].map((n) => raw(h`<span class="${n <= (it.my_rating || 0) ? 'on' : ''}" data-n="${n}">★</span>`))}</div>`) : ''}
            <textarea class="verdict" placeholder="${active.name === 'Finished' ? 'What worked, what did not, would you reread? This feeds your Reader DNA.' : 'For example: 80 pages; nothing happened and I disliked the narrator.'}">${it.my_verdict?.text || ''}</textarea>`) : ''}
          <div class="row" style="margin-top:12px"><button class="btn sm primary save">Save</button>
            <select class="btn sm move" style="width:auto"><option value="">Move to…</option>${list.filter((s) => s.id !== active.id).map((s) => raw(h`<option value="${s.id}">${s.name}</option>`))}</select>
            <button class="btn sm ghost rm">Remove</button></div>
        </div></div>`)) : raw(h`<div class="empty"><div class="big">Nothing here yet</div><div>Save a recommendation from a results page, or add a book by search, and it lands on this shelf.</div><a class="btn primary" href="#home">Find a book</a></div>`)}</div>
  </section>`;
  document.getElementById('newShelf').onclick = async () => { const name = prompt('Shelf name'); if (!name) return; const r = await post('/api/shelves', { name }); location.hash = `shelves/${r.id}`; };
  const ds = document.getElementById('delShelf'); if (ds) ds.onclick = async () => { if (confirm(`Delete shelf "${active.name}"?`)) { await del(`/api/shelves/${active.id}`); location.hash = 'shelves'; } };
  document.getElementById('addBook').onclick = () => { const s = document.getElementById('search'); s.hidden = !s.hidden; document.getElementById('q').focus(); };
  const q = document.getElementById('q');
  q.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    const box = document.getElementById('sres'); box.innerHTML = '<p class="cap sec" style="margin-top:12px">Searching…</p>';
    const res = await get(`/api/books/search?q=${encodeURIComponent(q.value)}`);
    box.innerHTML = res.map((r) => h`<div class="runner">${coverImg(r.cover, r.title)}<div><div class="ttl">${r.title}</div><div class="by">${r.author} · ${r.year || ''} ${rating(r.rating, r.ratingsCount)}</div><p style="margin-top:8px"><button class="btn sm" data-gid="${r.goodreadsId}">Add to ${active.name}</button></p></div></div>`).join('') || '<p class="cap sec" style="margin-top:12px">Nothing found.</p>';
    box.querySelectorAll('[data-gid]').forEach((b) => b.onclick = async () => { b.disabled = true; b.textContent = 'Fetching…'; const bk = await post('/api/books/import', { goodreadsId: b.dataset.gid }); await post(`/api/shelves/${active.id}/items`, { bookId: bk.id }); shelves(active.id); });
  };
  app.querySelectorAll('.item').forEach((el) => {
    const id = el.dataset.item;
    const ri = el.querySelector('.rating-input');
    if (ri) ri.querySelectorAll('span').forEach((s) => s.onclick = () => { ri.dataset.r = s.dataset.n; ri.querySelectorAll('span').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) <= Number(s.dataset.n))); });
    el.querySelector('.save').onclick = async () => {
      const v = el.querySelector('.verdict');
      await patch(`/api/shelf-items/${id}`, { note: el.querySelector('.note').value, my_rating: ri ? Number(ri.dataset.r) || null : null, my_verdict: v ? { text: v.value } : null });
      toast('Saved');
    };
    el.querySelector('.rm').onclick = async () => { await del(`/api/shelf-items/${id}`); shelves(active.id); };
    el.querySelector('.move').onchange = async (e) => {
      const target = list.find((s) => String(s.id) === e.target.value); if (!target) return;
      const it = items.find((x) => String(x.id) === id);
      let note = it.note; if (['Not for me', 'Did not finish'].includes(target.name)) { const w = prompt('Why? One line.'); if (w) note = w; }
      await post(`/api/shelves/${target.id}/items`, { bookId: it.book_id, note });
      if (target.kind !== 'system' || active.kind !== 'system') await del(`/api/shelf-items/${id}`);
      shelves(active.id);
    };
  });
}

// ---------- profile ----------
async function profile() {
  const p = await get('/api/profile');
  const dna = p.facts.find((f) => f.key === 'reader_dna');
  const answered = p.facts.filter((f) => f.source === 'answer' && f.key !== 'onboarding_completed');
  const inferred = p.facts.filter((f) => f.source === 'inferred' && !['reader_dna', 'questions_next_time'].includes(f.key));
  const rejected = p.facts.filter((f) => f.source === 'feedback');
  const qmap = Object.fromEntries(p.questions.map((q) => [q.id, q]));
  const [moods, st, ins, notes] = await Promise.all([get('/api/moods'), get('/api/state'), get('/api/insights'), get('/api/notes')]);
  const ar = st.autoReflect || {};
  app.innerHTML = h`<section class="section" style="padding-top:8px">
    <div class="row between"><h1>Reader DNA</h1><div class="row"><button class="btn primary sm" id="reflect">Rebuild from all evidence</button><button class="btn sm" id="redo">Revisit taste questions</button></div></div>
    ${dna ? raw(h`<p class="dna" style="margin-top:20px">${dna.value}</p><p class="cap sec" style="margin-top:8px">Built ${when(dna.observed_at)}</p>`) : raw(h`<div class="empty" style="margin-top:20px"><div class="big">Not built yet</div><div>Answer the taste questions and import your history, then rebuild. The best-tier model reads everything: answers, history, shelves, verdicts, rejected recommendations.</div></div>`)}
    <p class="cap sec" style="margin-top:12px">${ar.on ? `Rebuilds itself once a week when there is new evidence${ar.next ? `; next check after ${when(ar.next)}` : ''}${ar.newEvidence ? ' · new evidence waiting' : ''}.` : 'Automatic weekly rebuild is off (Settings).'}</p>
  </section>
  <section class="section"><h2>Mood over time</h2><p class="cap sec" style="margin-top:4px">Every check-in, oldest to newest. Hover a point for the whole session.</p>${moodChart(moods)}</section>
  <section class="section"><h2>What you say versus what you do</h2><p class="cap sec" style="margin-top:4px">What you asked for in each mood, against what you actually finished. ${ins.sayVsDo.told} of ${ins.sayVsDo.n} picks have an outcome${ins.sayVsDo.n > ins.sayVsDo.told ? raw(h`; <a href="#followups">tell me about the rest</a>`) : ''}.</p>
    ${ins.sayVsDo.sentences.length ? raw(h`<div class="msum">${ins.sayVsDo.sentences.map((x) => raw(h`<p>${x}</p>`))}</div>`) : raw('<p class="sec" style="margin-top:12px">Patterns appear once a few picks have outcomes. The home page asks after each session.</p>')}
    ${Object.keys(ins.sayVsDo.need).length ? raw(h`<div class="tablewrap" style="margin-top:16px"><table><tr><th>You asked the book to</th><th class="num">Picks</th><th class="num">Finished</th><th class="num">Dropped</th><th>Finished books were</th><th>Dropped books were</th></tr>${Object.entries(ins.sayVsDo.need).map(([k, g]) => raw(h`<tr><td>${k}</td><td class="num">${g.picks}</td><td class="num">${g.finished}</td><td class="num">${g.dropped}</td><td class="sec">${g.finishedTags.join(', ')}</td><td class="sec">${g.droppedTags.join(', ')}</td></tr>`))}</table></div>`) : ''}
  </section>
  <section class="section"><h2>Appeal fingerprint</h2><p class="cap sec" style="margin-top:4px">From every book you have a verdict on and that has a review digest (${ins.fingerprint.books} books). Finish rate and your average rating per appeal factor. Enrich your history on the History page to feed it.</p>
    ${ins.fingerprint.rows.length ? raw(h`${ins.fingerprint.loved.length ? raw(h`<p style="margin-top:12px"><b>You rate highest:</b> ${ins.fingerprint.loved.slice(0, 5).map((r) => `${r.tag} (${r.avg_rating}/5, ${r.n})`).join(' · ')}</p>`) : ''}${ins.fingerprint.dropped.length ? raw(h`<p style="margin-top:6px"><b>You drop most:</b> ${ins.fingerprint.dropped.slice(0, 5).map((r) => `${r.tag} (${r.dnf} of ${r.n})`).join(' · ')}</p>`) : ''}
    <div class="tablewrap" style="margin-top:12px"><table><tr><th>Appeal</th><th class="num">Books</th><th class="num">Finished</th><th class="num">Dropped</th><th class="num">Your avg</th><th>For example</th></tr>${ins.fingerprint.rows.slice(0, 25).map((r) => raw(h`<tr><td>${r.tag}</td><td class="num">${r.n}</td><td class="num">${r.finished}</td><td class="num">${r.dnf}</td><td class="num">${r.avg_rating ?? ''}</td><td class="sec">${r.titles.slice(0, 2).join(', ')}</td></tr>`))}</table></div>`) : raw('<p class="sec" style="margin-top:12px">Needs at least two books per factor. Import and enrich your history, or rate what you finish.</p>')}
  </section>
  <section class="section"><h2>Lines you underlined</h2>${notes.length ? raw(h`<div class="notes" style="margin-top:8px">${notes.slice(0, 12).map((n) => raw(h`<div class="quote">“${n.text}”<span class="cap sec"> ${n.title ? `${n.title} · ` : ''}${n.page ? `p. ${n.page} · ` : ''}${when(n.created_at)}</span></div>`))}</div>`) : raw('<p class="sec" style="margin-top:8px">Nothing yet. Any book page takes a sentence you underlined. It feeds the Reader DNA.</p>')}
    <p style="margin-top:16px"><a class="btn sm" href="#report">Reading report</a></p></section>
  <section class="section"><h2>Your answers</h2><p class="cap sec" style="margin-top:4px">Stable taste. Each keeps its date; earlier answers stay in history.</p><div style="margin-top:12px">${answered.map((f) => raw(h`<div class="fact"><div class="k">${qmap[f.key]?.text || f.key}</div><div>${(f.value?.labels || []).join(', ')}${f.value?.text ? raw(h`${f.value.labels?.length ? ' · ' : ''}<i>${f.value.text}</i>`) : ''}</div><div class="m">${when(f.observed_at)} · <a href="#" data-hist="${f.key}">history</a></div></div>`))}</div></section>
  <section class="section"><h2>Inferred patterns</h2><p class="cap sec" style="margin-top:4px">From history, verdicts and feedback. Delete anything wrong.</p><div style="margin-top:12px">${inferred.length ? inferred.map((f) => raw(h`<div class="fact"><div class="k">${f.key.replace(/^inferred_/, '').replace(/_/g, ' ')} <span class="chip">${Math.round(f.confidence * 100)}% sure</span></div><div>${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}</div><div class="m">${f.note || ''} · <a href="#" data-delfact="${f.id}">delete</a></div></div>`)) : raw('<p class="sec">Nothing yet.</p>')}
    ${rejected.length ? raw(h`<h3 style="margin-top:24px">Rejections you explained</h3>${rejected.map((f) => raw(h`<div class="fact"><div>${f.value?.note}</div><div class="m"><a href="#" data-delfact="${f.id}">delete</a></div></div>`))}`) : ''}</div></section>
  `;
  wireMoodChart();
  document.getElementById('reflect').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Thinking (one or two minutes)…'; try { await post('/api/profile/reflect'); profile(); } catch (err) { toast(err.message); e.target.disabled = false; } };
  document.getElementById('redo').onclick = async () => { const s = await post('/api/sessions', { mode: 'onboarding' }); location.hash = `interview/${s.id}`; };
  app.querySelectorAll('[data-delfact]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); await del(`/api/profile/fact/${a.dataset.delfact}`); profile(); });
  app.querySelectorAll('[data-hist]').forEach((a) => a.onclick = async (e) => {
    e.preventDefault(); const hs = await get(`/api/profile/history/${a.dataset.hist}`);
    alert(hs.map((x) => `${when(x.observed_at)}: ${(x.value?.labels || []).join(', ')}${x.value?.text ? ' · ' + x.value.text : ''}`).join('\n'));
  });
}

// ---------- mood chart: three single-series strip charts over sessions, plus the words ----------
const SCALES = [['demand', 'Effort', 'easy', 'demanding'], ['tone', 'Light / dark', 'light', 'dark'], ['safe', 'Safe / disturbing', 'safe', 'disturbing']];
const SHORT_MOOD = { good_energetic: 'Good, energetic', good_calm: 'Good, calm', flat: 'Flat', stressed: 'Stressed', low: 'Low', raw: 'Raw', restless: 'Restless' };
function moodChart(all) {
  if (!all.length) return raw('<div class="empty" style="margin-top:12px"><div class="big">No check-ins yet</div><div>Your mood, need, effort and light-dark answers land here after each interview.</div></div>');
  const n = Math.min(all.length, window.innerWidth < 640 ? 8 : 16);
  const rows = all.slice(-n);
  const tip = (m) => esc(`${when(m.at)} · ${SHORT_MOOD[m.mood_id] || m.mood || ''} · ${m.need || ''}${m.demand ? ` · effort ${m.demand}/5` : ''}${m.tone ? ` · dark ${m.tone}/5` : ''}${m.safe ? ` · disturbing ${m.safe}/5` : ''}${m.life?.length && m.life[0] !== 'Nothing special' ? ` · ${m.life.join(', ')}` : ''}`);
  const cols = `--n:${n}`;
  const scale = ([key, name, lo, hi]) => {
    const pts = rows.map((m, i) => (m[key] ? [i, m[key]] : null)).filter(Boolean);
    return raw(h`<div class="mlabel"><b>${name}</b><span>${hi} 5</span><span>${lo} 1</span></div>
      <div class="plot" style="${cols}">
        <svg viewBox="0 0 ${n} 4" preserveAspectRatio="none" aria-hidden="true">${pts.length > 1 ? raw(`<polyline points="${pts.map(([i, v]) => `${i + 0.5},${5 - v}`).join(' ')}" />`) : ''}</svg>
        ${pts.map(([i, v]) => raw(h`<span class="dot" style="left:${((i + 0.5) / n) * 100}%;top:${((5 - v) / 4) * 100}%" data-tip="${tip(rows[i])}" role="img" aria-label="${v} of 5"></span>`))}
      </div>`);
  };
  const words = (label, f) => raw(h`<div class="mlabel"><b>${label}</b></div><div class="mwords" style="${cols}">${rows.map((m) => raw(h`<span data-tip="${tip(m)}">${f(m) || '·'}</span>`))}</div>`);
  const summary = moodSummary(all);
  return raw(h`<div class="mchart" style="margin-top:16px">
    ${SCALES.map(scale)}
    ${words('Date', (m) => new Date(m.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}
    ${words('Mood', (m) => SHORT_MOOD[m.mood_id] || m.mood)}
    ${words('Need', (m) => m.need)}
  </div>
  <div class="mtip" id="mtip" hidden></div>
  ${all.length > n ? raw(h`<p class="cap sec" style="margin-top:8px">Showing the last ${n} of ${all.length} check-ins.</p>`) : ''}
  ${summary.length ? raw(h`<div class="msum">${summary.map((s) => raw(h`<p>${s}</p>`))}</div>`) : raw('<p class="cap sec" style="margin-top:12px">Patterns appear after three or more check-ins.</p>')}`);
}
function moodSummary(all) {
  if (all.length < 3) return [];
  const count = (arr) => { const c = {}; for (const x of arr) if (x) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]); };
  const out = [];
  const [topMood] = count(all.map((m) => SHORT_MOOD[m.mood_id] || m.mood));
  const [topNeed] = count(all.map((m) => m.need));
  if (topMood) out.push(`Most often you arrive ${topMood[0].toLowerCase()} (${topMood[1]} of ${all.length} check-ins)${topNeed ? ` and ask the book to ${topNeed[0].toLowerCase()}` : ''}.`);
  const hard = all.filter((m) => ['stressed', 'low', 'raw', 'flat', 'restless'].includes(m.mood_id));
  const hardNeeds = count(hard.map((m) => m.need));
  if (hard.length >= 2 && hardNeeds.length) out.push(`On harder days (${hard.length}) you have asked for: ${hardNeeds.slice(0, 3).map(([k, v]) => `${k.toLowerCase()} ×${v}`).join(', ')}.`);
  const avg = (k) => { const v = all.map((m) => m[k]).filter(Boolean); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const d = avg('demand'), t = avg('tone'), s = avg('safe');
  if (d) out.push(`Average asks: effort ${d.toFixed(1)}/5, darkness ${t ? t.toFixed(1) : '?'}/5, disturbing ${s ? s.toFixed(1) : '?'}/5.`);
  const recent = all.slice(-3).map((m) => m.demand).filter(Boolean);
  if (recent.length === 3 && d && recent.every((v) => v < d - 0.5)) out.push('Your last three check-ins asked for less effort than usual. Worth noticing.');
  return out;
}
function wireMoodChart() {
  const tip = document.getElementById('mtip'); if (!tip) return;
  app.querySelectorAll('[data-tip]').forEach((el) => {
    el.onmouseenter = el.onfocus = () => { tip.textContent = el.dataset.tip; tip.hidden = false; const r = el.getBoundingClientRect(); tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 16, Math.max(16, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px'; tip.style.top = (r.top + window.scrollY - tip.offsetHeight - 10) + 'px'; };
    el.onmouseleave = el.onblur = () => (tip.hidden = true);
  });
}

// ---------- history ----------
async function history() {
  const rows = await get('/api/history');
  app.innerHTML = h`<section class="section" style="padding-top:8px"><h1>Reading history</h1>
    <p class="sec" style="margin-top:12px;max-width:65ch">Import your Goodreads export (My Books → Import and export → Export library) or StoryGraph export (Manage account → Export), or any CSV with Title, Author and Rating columns. Imports feed your Reader DNA and are never recommended again.</p>
    <div class="row" style="margin-top:16px"><input type="file" id="csv" accept=".csv,text/csv" style="width:auto"><button class="btn primary" id="imp">Import</button><span id="impres" class="cap sec"></span></div>
  </section>
  <section class="section"><div class="row between"><h2>Give the history real data</h2><button class="btn sm primary" id="enrich">Enrich 20 books</button></div>
    <p class="sec" style="margin-top:8px;max-width:65ch">Fetches the Goodreads page and reads the reviews for your five-star, one- and two-star and abandoned books (${rows.filter((r) => !r.book_id).length} not yet linked). That is what turns ratings into an appeal fingerprint: what you finish, what you drop, in appeal terms. Twenty books take a few minutes; run it again for the next twenty.</p>
    <div id="enrichStatus" class="cap sec" style="margin-top:8px"></div></section>
  <section class="section"><h2>Add one book</h2><div class="row" style="margin-top:12px"><input type="text" id="mt" placeholder="Title" style="flex:2;min-width:200px"><input type="text" id="ma" placeholder="Author" style="flex:1;min-width:160px"><select id="mr" style="width:auto"><option value="">Rating</option>${[5, 4, 3, 2, 1].map((n) => raw(`<option>${n}</option>`))}</select><select id="ms" style="width:auto"><option value="read">Read</option><option value="dnf">Did not finish</option></select><button class="btn" id="madd">Add</button></div><input type="text" id="mrev" placeholder="A line on what you thought (optional, valuable)" style="margin-top:8px"></section>
  <section class="section"><h2>${rows.length} ${rows.length === 1 ? 'book' : 'books'}</h2>${rows.length ? raw(h`<div class="tablewrap" style="margin-top:12px"><table><tr><th>Title</th><th>Author</th><th>Rating</th><th>Status</th><th>Read</th><th>Source</th><th></th></tr>${rows.slice(0, 400).map((r) => raw(h`<tr><td>${r.book_id ? raw(h`<a href="#book/${r.book_id}" style="color:inherit"><b>${r.title}</b></a>`) : raw(h`<b>${r.title}</b>`)}${r.my_review ? raw(h`<div class="cap sec">${r.my_review.slice(0, 160)}</div>`) : ''}</td><td>${r.author || ''}</td><td>${r.my_rating ? raw(h`<span style="color:var(--amber)">${'★'.repeat(r.my_rating)}</span>`) : ''}</td><td>${r.status}</td><td>${r.date_read ? String(r.date_read).slice(0, 10) : ''}</td><td class="sec">${r.source.replace('_csv', '')}</td><td><a href="#" data-delh="${r.id}" title="Delete">✕</a></td></tr>`))}</table></div>${rows.length > 400 ? raw('<p class="cap sec">Showing the first 400.</p>') : ''}`) : raw(h`<div class="empty" style="margin-top:12px"><div class="big">No history yet</div><div>Import a Goodreads or StoryGraph export above, or add books one by one.</div></div>`)}</section>`;
  const es = document.getElementById('enrichStatus');
  const pollEnrich = async () => { const j = await get('/api/history/enrich'); if (!j.total && !j.running) return; es.innerHTML = h`${j.running ? raw('<span class="spinner"></span> ') : ''}${j.done} of ${j.total} · ${j.log.slice(-3).join(' · ')}`; if (j.running) setTimeout(pollEnrich, 2500); else history(); };
  document.getElementById('enrich').onclick = async (e) => { e.target.disabled = true; await post('/api/history/enrich', { limit: 20 }); pollEnrich(); };
  get('/api/history/enrich').then((j) => { if (j.running) { document.getElementById('enrich').disabled = true; pollEnrich(); } });
  document.getElementById('imp').onclick = async () => {
    const f = document.getElementById('csv').files[0]; if (!f) return toast('Choose a CSV file first');
    const csv = await f.text(); const r = await post('/api/history/import', { csv });
    document.getElementById('impres').textContent = `Imported ${r.imported} rows (${r.source}).`; history();
  };
  document.getElementById('madd').onclick = async () => {
    const title = document.getElementById('mt').value.trim(); if (!title) return;
    await post('/api/history', { title, author: document.getElementById('ma').value.trim(), rating: Number(document.getElementById('mr').value) || null, status: document.getElementById('ms').value, review: document.getElementById('mrev').value.trim() || null });
    history();
  };
  app.querySelectorAll('[data-delh]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); await del(`/api/history/${a.dataset.delh}`); history(); });
}

// ---------- reading report ----------
async function report(period = 'quarter') {
  const st = await get(`/api/report?period=${period}`);
  const rc = st.recommendations;
  const row = (k, v) => raw(h`<div class="stat"><span class="tabular big">${v}</span><span class="cap sec">${k}</span></div>`);
  app.innerHTML = h`<section class="section" style="padding-top:8px"><div class="row between"><h1>Reading report</h1><div class="row">${[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']].map(([k, l]) => raw(h`<a class="btn sm ${k === period ? 'on' : ''}" href="#report/${k}">${l}</a>`))}</div></div>
    <p class="cap sec" style="margin-top:8px">Since ${st.from}. Honest accounting for the tool as much as for you.</p>
    <div class="stats">${row('picks', rc.picks)}${row('finished', rc.finished)}${row('dropped', rc.dropped)}${row('kept for later', rc.later)}${row('rejected', rc.rejected)}${row('no outcome yet', rc.untold)}${row('check-ins', st.moods.checkins)}${row('verdicts asked', st.verdicts)}${row('lines underlined', st.notes)}</div>
    ${rc.untold ? raw(h`<p class="cap" style="margin-top:8px"><a href="#followups">Tell me what happened with the ${rc.untold} without an outcome</a></p>`) : ''}
  </section>
  <section class="section"><h2>What worked</h2>
    ${Object.keys(st.by_slot).length ? raw(h`<div class="tablewrap" style="margin-top:12px"><table><tr><th>Kind of pick</th><th class="num">Picks</th><th class="num">Finished</th><th class="num">Dropped</th></tr>${Object.entries(st.by_slot).map(([k, g]) => raw(h`<tr><td>${k}</td><td class="num">${g.picks}</td><td class="num">${g.finished}</td><td class="num">${g.dropped}</td></tr>`))}</table></div>`) : raw('<p class="sec" style="margin-top:8px">No picks in this period.</p>')}
    ${st.calibration.confidence_when_finished != null || st.calibration.confidence_when_dropped != null ? raw(h`<p class="cap sec" style="margin-top:10px">The tool's own confidence: ${st.calibration.confidence_when_finished ?? '?'} on books you finished, ${st.calibration.confidence_when_dropped ?? '?'} on books you dropped. If those are close, its confidence means little yet.</p>`) : ''}
    ${st.finished_titles.length ? raw(h`<p style="margin-top:12px"><b>Finished:</b> ${st.finished_titles.join(' · ')}</p>`) : ''}
    ${st.drop_reasons.length ? raw(h`<p style="margin-top:8px"><b>Dropped, and why:</b></p><ul class="plain">${st.drop_reasons.map((x) => raw(h`<li>${x}</li>`))}</ul>`) : ''}
  </section>
  <section class="section"><h2>How your asks drifted</h2><div class="tablewrap" style="margin-top:12px"><table><tr><th></th><th>This period</th><th>Before</th></tr><tr><td>Mood</td><td>${st.moods.mood_now.join(', ') || '·'}</td><td class="sec">${st.moods.mood_before.join(', ') || '·'}</td></tr><tr><td>Need</td><td>${st.moods.need_now.join(', ') || '·'}</td><td class="sec">${st.moods.need_before.join(', ') || '·'}</td></tr></table></div>
    ${st.say_vs_do.length ? raw(h`<div class="msum">${st.say_vs_do.map((x) => raw(h`<p>${x}</p>`))}</div>`) : ''}</section>
  <section class="section"><div class="row between"><h2>In words</h2><button class="btn sm primary" id="write">Write the report</button></div><div id="narr"><p class="sec" style="margin-top:8px">The best-tier model reads these numbers and your profile and writes a page: what worked, where the tool was wrong, what to try next.</p></div></section>`;
  document.getElementById('write').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Writing…';
    try { const r = await post('/api/report', { period }); const n = r.narrative; document.getElementById('narr').innerHTML = h`<h3 style="margin-top:12px">${n.headline}</h3><div class="prose" style="margin-top:10px">${raw(md(n.narrative))}</div>${n.patterns?.length ? raw(h`<p style="margin-top:12px"><b>Patterns</b></p><ul class="plain">${n.patterns.map((x) => raw(h`<li>${x}</li>`))}</ul>`) : ''}${n.suggestions?.length ? raw(h`<p style="margin-top:12px"><b>Try next</b></p><ul class="plain">${n.suggestions.map((x) => raw(h`<li>${x}</li>`))}</ul>`) : ''}`; }
    catch (err) { toast(err.message); }
    e.target.disabled = false; e.target.textContent = 'Write again';
  };
}

// ---------- settings ----------
async function settings() {
  const [s, ops] = await Promise.all([get('/api/settings'), get('/api/ops')]);
  const tiers = ['fast', 'smart', 'best', 'max'];
  const steps = [['brief', 'Brief (reads your answers)'], ['adaptive', 'Adaptive follow-up questions'], ['candidates', 'Long list of candidates (the hard step)'], ['digest', 'Review digests (one per book, cached)'], ['rank', 'Final slate'], ['reflect', 'Reader DNA rebuild'], ['verdict', '"Should I read this?" verdicts'], ['chat', 'Conversations about a book']];
  app.innerHTML = h`<section class="section" style="padding-top:8px"><h1>Settings</h1>
    <p class="sec" style="margin-top:12px;max-width:65ch">Runs on your Claude Max login through the Agent SDK. No API key. Higher tiers are slower and use more of your plan.</p></section>
    <section class="section"><h2>Model per step</h2><div class="tablewrap" style="margin-top:12px"><table>${steps.map(([k, label]) => raw(h`<tr><td>${label}</td><td><select data-tier="${k}" style="width:auto">${tiers.map((t) => raw(h`<option value="${t}" ${s.tiers[k] === t ? 'selected' : ''}>${t} · ${s.models[t]}</option>`))}</select></td></tr>`))}</table></div></section>
    <section class="section"><h2>Model ids per tier</h2><div class="tablewrap" style="margin-top:12px"><table>${tiers.map((t) => raw(h`<tr><td style="width:120px">${t}</td><td><input type="text" data-model="${t}" value="${s.models[t]}" placeholder="${s.defaults[t]}"></td></tr>`))}</table></div></section>
    <section class="section"><h2>Research</h2>
      <label class="lbl"><input type="checkbox" id="web" ${s.candidates_web ? 'checked' : ''}> Let the candidate step use web search (helps with very recent and Polish titles; slower)</label>
      <label class="lbl"><input type="checkbox" id="chatWeb" ${s.chat_web ? 'checked' : ''}> Let conversations about a book look things up on the web (editions, narrators, sequels; a little slower)</label>
      <label class="lbl"><input type="checkbox" id="autoReflect" ${s.auto_reflect ? 'checked' : ''}> Rebuild Reader DNA automatically once a week when there is new evidence</label>
      <label class="lbl">Adaptive follow-up questions per session (0 to 4)</label><input type="number" id="adaptive" min="0" max="4" value="${s.adaptive_count}" style="width:90px">
      <label class="lbl">Hardcover.app API token (optional; adds crowd moods and content warnings from a sanctioned source). Currently: ${s.hardcover_token || 'not set'}</label><input type="text" id="hc" placeholder="paste token, or leave empty">
      <p class="cap sec" style="margin-top:12px">Polish: when a session asks for Polish-language books, lubimyczytac.pl ratings (1 to 10) and Polish reviews are pulled too.</p>
      <p style="margin-top:20px"><button class="btn primary" id="save">Save settings</button></p></section>
    <section class="section"><h2>Data</h2><p class="sec" style="margin-top:8px">Everything lives in <code>data/bookfinder.db</code> next to the app. A copy is made in <code>data/backups</code> every day the app starts; the last seven are kept.</p>
      <div class="row" style="margin-top:12px"><button class="btn sm" id="backup">Back up now</button><a class="btn sm" href="/api/ops/export">Export everything (JSON)</a><input type="file" id="impf" accept=".json,application/json" style="width:auto"><button class="btn sm" id="impb">Import</button><label class="cap sec"><input type="checkbox" id="impReplace"> replace everything (otherwise merge)</label></div>
      <p class="cap sec" style="margin-top:8px">Backups: ${ops.backups.length ? ops.backups.map((b) => b.file.replace('bookfinder-', '').replace('.db', '')).join(', ') : 'none yet'}.</p></section>
    <section class="section"><div class="row between"><h2>Data sources</h2><button class="btn sm" id="health">Check now</button></div>
      <p class="sec" style="margin-top:8px">${ops.health.checkedAt ? raw(h`Checked ${when(ops.health.checkedAt)}: Goodreads search ${ops.health.goodreadsSearch ? 'ok' : 'failing'}, Goodreads book page ${ops.health.goodreadsPage ? 'ok' : 'failing'}, lubimyczytac.pl ${ops.health.lubimyczytac ? 'ok' : 'failing'}.${ops.health.problems.length ? raw(h` <span style="color:var(--danger)">${ops.health.problems.join(' ')}</span>`) : ''}`) : 'Not checked yet; runs ten seconds after start.'}</p></section>
    <section class="section"><h2>Phone on your home network</h2>
      <p class="sec" style="margin-top:8px;max-width:65ch">Off by default. When on, the app also listens on your home network and any other device must open a one-time link carrying a secret token (it sets a cookie). Only turn this on at home, on a network you trust, and never forward the port to the internet.</p>
      <label class="lbl"><input type="checkbox" id="lan" ${ops.lan.enabled ? 'checked' : ''}> Allow other devices on this network (restart the app after changing)</label>
      <div id="lanUrl" class="cap" style="margin-top:8px"></div></section>`;
  document.getElementById('backup').onclick = async () => { const r = await post('/api/ops/backup'); toast(r ? 'Backup written' : 'No database file to back up'); };
  document.getElementById('impb').onclick = async () => {
    const f = document.getElementById('impf').files[0]; if (!f) return toast('Choose an export file first');
    const replace = document.getElementById('impReplace').checked;
    if (replace && !confirm('Replace everything in the database with the file? Existing data will be deleted.')) return;
    try { const data = JSON.parse(await f.text()); const r = await post('/api/ops/import', { data, replace }); toast('Imported: ' + Object.entries(r.imported).map(([k, v]) => `${k} ${v}`).join(', ')); } catch (e) { toast(e.message); }
  };
  document.getElementById('health').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Checking…'; await post('/api/ops/health'); settings(); };
  const lanBox = document.getElementById('lan'); const lanUrl = document.getElementById('lanUrl');
  const showLan = (r) => { lanUrl.innerHTML = r.url ? h`On this device the link is: <code>${r.url}</code>. Open it once on your phone, then use the address without the token. Restart the app for the change to take effect.` : ''; };
  if (ops.lan.enabled) get('/api/ops/lan-url').then(showLan);
  lanBox.onchange = async () => { const r = await post('/api/ops/lan', { enabled: lanBox.checked }); showLan(r); toast(lanBox.checked ? 'Home-network mode on after restart' : 'Home-network mode off after restart'); };
  document.getElementById('save').onclick = async () => {
    const body = { candidates_web: document.getElementById('web').checked, adaptive_count: document.getElementById('adaptive').value, chat_web: document.getElementById('chatWeb').checked, auto_reflect: document.getElementById('autoReflect').checked };
    const hc = document.getElementById('hc').value.trim(); if (hc) body.hardcover_token = hc;
    app.querySelectorAll('[data-tier]').forEach((el) => (body['tier_' + el.dataset.tier] = el.value));
    app.querySelectorAll('[data-model]').forEach((el) => (body['model_' + el.dataset.model] = el.value.trim()));
    await post('/api/settings', body); toast('Settings saved');
  };
}

router();
