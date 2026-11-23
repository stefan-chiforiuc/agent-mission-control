// Mission Control core: everything a "view" needs so that a view only has to draw.
//
// A view is a file views/<id>.html that includes /core.css and /core.js, has <header id="mc-header"></header>,
// and calls MC.start({ id, onSnap, onEvent, onSession, onReset, onTheme }):
//   onSnap(snap, all)   the current session's state changed (snap = {title, agents:[...], replay, live, ...})
//   onEvent(ev, snap)   one live/replayed message: kind = prompt | handoff | result | tool | text
//   onSession(snap)     the user switched to a different session: reset your view-local state
//   onReset()           server cleared everything
//   onTheme()           colour theme changed
//   onFocusAgent(id)    optional: the user clicked the "N waiting" chip; select/scroll to that agent
// Agent statuses: running | thinking | delegating | blocked (approval dialog open) | asking (question open) | idle | done.
// snap.waiting = [{ key, aid, kind: 'approval' | 'question', tool, text, questions, since }] lists what the human must answer in the terminal.
// Use MC.* helpers below (names, colours, clock, tree, formatting). Drop the file in views/ and it appears in the dropdown.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PALETTES = {
    neon:  ['#00e5ff', '#ff3df2', '#b6ff3c', '#ffb02e', '#7c5cff', '#ff5c7a', '#2effa8', '#4da3ff'],
    amber: ['#ffb000', '#ff6a00', '#ffd666', '#ff3b30', '#c9ff5c', '#ff8fab', '#8affc1', '#ffa94d'],
    matrix: ['#39ff88', '#00d4ff', '#c6ff00', '#ff4d9d', '#ffd400', '#7b8cff', '#00ffd5', '#ff8a3d'],
  };
  const MC = window.MC = { PALETTES, esc, S: { snaps: new Map(), events: new Map(), sel: 'auto', theme: 'neon', curId: null, speed: 4, agentMode: 'all' }, view: null };
  const S = MC.S;
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  // the chosen session survives switching views (kept per browser tab)
  const ssGet = k => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const setSel = v => { S.sel = v; try { sessionStorage.setItem('mc-sel', v); } catch {} };
  const post = (p, b) => fetch(p, { method: 'POST', body: JSON.stringify(b || {}) }).then(r => r.json()).catch(() => ({}));

  /* ---------- formatting ---------- */
  MC.fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
  MC.fmtD = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'; return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'; };
  MC.shortModel = m => (m || '').replace(/^claude-/, '') || '—';
  MC.mclass = m => /opus/.test(m) ? 'm-opus' : /sonnet/.test(m) ? 'm-sonnet' : /haiku/.test(m) ? 'm-haiku' : 'm-x';
  MC.alpha = (hex, a) => hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
  MC.TOOLICON = { Bash: '⌨', Read: '📖', Edit: '✎', Write: '✎', Grep: '🔍', Glob: '🔍', WebFetch: '🌐', WebSearch: '🌐', Agent: '⇢', Task: '⇢' };

  /* ---------- session access ---------- */
  // A picked session stays picked. "Follow latest" is sticky: it only moves to a newer session once the current one has been quiet for 90s,
  // so a second terminal (or a replay) can't yank the view away from the session you are watching.
  // MC.rawCur() is the full session; MC.cur() is the same session with snap.agents reduced to what the "Agents" dropdown shows
  // (the full list stays reachable as snap._full, and colours / "#2" numbering are always computed from the full list so they don't shift).
  MC.rawCur = () => {
    if (S.sel !== 'auto' && S.snaps.has(S.sel)) return S.snaps.get(S.sel);
    const prev = S.autoId && S.snaps.get(S.autoId);
    if (prev && prev.live && !prev.replay && Date.now() - prev.last < 90000) return prev;
    const latest = [...S.snaps.values()].sort((a, b) => b.last - a.last)[0] || null;
    S.autoId = latest ? latest.id : null; return latest;
  };
  let filtCache = null;
  MC.cur = () => {
    const raw = MC.rawCur(); if (!raw || S.agentMode === 'all') return raw;
    const tick = Math.floor(Date.now() / 1000);       // statuses age with time (e.g. "idle" after 2 min), so recompute at most once a second
    if (filtCache && filtCache.raw === raw && filtCache.mode === S.agentMode && filtCache.tick === tick) return filtCache.snap;
    filtCache = { raw, mode: S.agentMode, tick, snap: MC.filterSnap(raw, S.agentMode) };
    return filtCache.snap;
  };
  MC.AGENT_MODES = {
    all: 'Agents: all (history)',
    active: 'Agents: active only',
    latest: 'Agents: latest per type',
  };
  const ACTIVE = ['running', 'thinking', 'delegating', 'blocked', 'asking'];
  MC.ACTIVE = ACTIVE;
  MC.isBlocked = st => st === 'blocked' || st === 'asking';
  // Claude ended its turn, nothing asks you anything and no agent is still busy: the next move is yours. Returns since when, or 0.
  // shortcut: a session counts as live only ~10 min after its last activity, so the "your turn" state ends with it.
  MC.yourTurn = snap => {
    snap = snap && (snap._full || snap);
    if (!snap || snap.replay || !snap.live || (snap.waiting || []).length) return 0;
    const m = snap.agents.find(a => a.id === 'main');
    if (!m || m.status !== 'idle') return 0;
    return snap.agents.some(a => a.id !== 'main' && ACTIVE.includes(MC.effStatus(a, snap))) ? 0 : m.last;
  };
  MC.TURN = '#3dff7a';
  // all    = every agent the session ever had
  // active = main + agents that are working right now
  // latest = per agent type: the ones working right now; if none of that type is working, the last one that ran
  //          (plus any that ran in parallel with it), so finished work stays visible once without piling up history
  MC.filterSnap = (snap, mode) => {
    const all = snap.agents, isActive = a => ACTIVE.includes(MC.effStatus(a, snap)), keep = new Set();
    for (const a of all) if (a.id === 'main') keep.add(a.id);
    if (mode === 'active') { for (const a of all) if (isActive(a)) keep.add(a.id); }
    else if (mode === 'latest') {
      const byType = new Map();
      for (const a of all) if (a.id !== 'main') { const k = a.type || 'agent'; if (!byType.has(k)) byType.set(k, []); byType.get(k).push(a); }
      for (const list of byType.values()) {
        const act = list.filter(isActive);
        if (act.length) { act.forEach(a => keep.add(a.id)); continue; }
        const last = list.reduce((x, y) => (y.first > x.first ? y : x));
        // the last one, and every one still running when it started (a parallel batch)
        for (const a of list) if (a === last || (a.end || a.last) >= last.first) keep.add(a.id);
      }
    } else return snap;
    // a shown agent whose parent is hidden hangs off its nearest shown ancestor instead
    const byId = MC.agentsOf(snap), up = id => { let p = id, guard = 0; while (p && !keep.has(p) && guard++ < 50) p = (byId.get(p) || {}).parent; return p && keep.has(p) ? p : 'main'; };
    const agents = all.filter(a => keep.has(a.id)).map(a => a.id === 'main' || keep.has(a.parent) ? a : { ...a, parent: up(a.parent) });
    return { ...snap, agents, _full: snap, _hidden: all.length - agents.length };
  };
  MC.agentsOf = snap => new Map((snap ? snap.agents : []).map(a => [a.id, a]));

  // "now" in the session's own time: wall clock when live, the playback cursor during a replay, the last event for a finished session
  MC.nowOf = snap => {
    if (!snap) return Date.now();
    if (snap.replay) return snap.replay.paused || snap.replay.done ? snap.replay.clock : snap.replay.clock + (Date.now() - (snap._rcv || Date.now()));
    return snap.live ? Date.now() : (snap.last || Date.now());
  };
  // an agent whose session is over (or that has been silent for 2 minutes) isn't really "running"
  MC.effStatus = (a, snap) => {
    if (a.status === 'done') return 'done';
    if (!snap.live) return 'idle';
    if (a.status === 'thinking' && MC.nowOf(snap) - a.last > 120000) return 'idle';
    return a.status;
  };
  // Progress estimates. Claude Code doesn't report how far a command is, so the server sends how long the same kind of call
  // (a.actEst, e.g. "npm test") or the same agent type (a.lifeEst) usually took in this project; 0 = no history yet.
  // frac climbs to 90% at the usual time, then creeps towards 99% so an overrunning task never looks finished.
  MC.estFrac = (el, est) => el <= est ? 0.9 * el / est : 0.9 + 0.09 * (1 - Math.exp(-(el - est) / est));
  const prog = (el, est, n) => ({ el: Math.max(0, el), est: est || 0, n: n || 0, frac: est ? MC.estFrac(Math.max(0, el), est) : null, over: !!est && el > est });
  MC.progress = (a, snap, now = MC.nowOf(snap)) => prog(now - (a.actSince || now), a.actEst, a.actEstN);   // the current action
  MC.lifeProgress = (a, snap, now = MC.nowOf(snap)) => prog((a.end || now) - (a.first || now), a.lifeEst, a.lifeEstN);   // the agent as a whole
  MC.estText = (p, short) => !p.est ? MC.fmtD(p.el) : short ? `${MC.fmtD(p.el)}/~${MC.fmtD(p.est)}` : p.over ? `${MC.fmtD(p.el)} · usually ~${MC.fmtD(p.est)}` : `${MC.fmtD(p.el)} of ~${MC.fmtD(p.est)}`;
  // "coder", or "coder #2" when the same type was spawned more than once
  MC.nameMap = snap => {
    const m = new Map(), count = {}, total = {}, list = [...(snap._full || snap).agents].sort((a, b) => a.first - b.first);
    for (const a of list) total[a.type] = (total[a.type] || 0) + 1;
    for (const a of list) { count[a.type] = (count[a.type] || 0) + 1; m.set(a.id, a.id === 'main' ? 'main' : total[a.type] > 1 ? `${a.type} #${count[a.type]}` : a.type); }
    m.set('user', 'you'); return m;
  };
  MC.colorOf = (sid, id) => {
    const P = PALETTES[S.theme] || PALETTES.neon;
    if (id === 'user') return '#e8f1ff'; if (id === 'main') return P[0];
    const snap = S.snaps.get(sid); if (!snap) return P[1];
    if (!snap._ci) snap._ci = new Map(snap.agents.filter(a => a.id !== 'main').sort((a, b) => a.first - b.first || (a.id < b.id ? -1 : 1)).map((a, i) => [a.id, i]));
    return P[((snap._ci.get(id) ?? 0) + 1) % 8];
  };
  // parent/child tree with "main" as root; unknown parents attach to the root
  MC.buildTree = snap => {
    const byId = MC.agentsOf(snap), kids = new Map(); for (const a of snap.agents) kids.set(a.id, []);
    const root = byId.get('main') || snap.agents[0]; if (!root) return null;
    for (const a of snap.agents) { if (a.id === root.id) continue; kids.get(byId.has(a.parent) ? a.parent : root.id).push(a); }
    for (const l of kids.values()) l.sort((x, y) => x.first - y.first);
    return { root, kids };
  };
  // should this event be animated? (not when the server is just re-sending history to a new tab)
  MC.isFresh = ev => !ev.hist && (ev.replay || Date.now() - ev.ts < 20000);

  /* ---------- session strip (optional, used by views that want it) ---------- */
  MC.stripHTML = snap => {
    if (!snap) return '<span class="pill">no session yet</span>';
    const hidden = snap._hidden || 0; snap = snap._full || snap;
    const a = snap.agents, now = MC.nowOf(snap), sum = k => a.reduce((s, x) => s + x.tok[k], 0), mainA = a.find(x => x.id === 'main');
    const models = [...new Set(a.map(x => x.model).filter(Boolean))], effs = [...new Set(a.map(x => x.effort).filter(Boolean))];
    const active = a.filter(x => x.id !== 'main' && ACTIVE.includes(MC.effStatus(x, snap))).length, nw = (snap.waiting || []).length;
    const cwd = (snap.cwd || '').split(/[\\/]/).slice(-2).join('/');
    return [
      `<span class="title" title="${esc(snap.title)}">${esc(snap.title || 'Untitled session')}</span>`,
      nw ? `<span class="pill wait">⏸ <b>${nw}</b> waiting on you</span>` : '',
      snap.replay ? `<span class="pill rp">⏵ REPLAY</span>` : snap.live ? '<span class="pill live">● LIVE</span>' : '<span class="pill">ended</span>',
      `<span class="pill">⏱ <b>${MC.fmtD(now - snap.first)}</b></span>`,
      snap.cost && snap.cost.usd != null ? `<span class="pill">$ <b>${snap.cost.usd.toFixed(2)}</b></span>` : '',
      `<span class="pill" title="uncached input / cache read / output tokens, all agents">in <b>${MC.fmtK(sum('in') + sum('cw'))}</b> · cache <b>${MC.fmtK(sum('cr'))}</b> · out <b>${MC.fmtK(sum('out'))}</b></span>`,
      `<span class="pill">agents <b>${a.length - (mainA ? 1 : 0)}</b>${active ? ` · <b style="color:#3dff7a">${active} active</b>` : ''}${hidden ? ` · ${hidden} hidden` : ''}</span>`,
      models.map(m => `<span class="mc ${MC.mclass(m)}">${esc(MC.shortModel(m))}</span>`).join(''),
      effs.length ? `<span class="pill">effort <b>${esc(effs.join('/'))}</b></span>` : '',
      snap.permissionMode ? `<span class="pill">perm <b>${esc(snap.permissionMode)}</b></span>` : '',
      snap.branch ? `<span class="pill">⎇ <b>${esc(snap.branch)}</b></span>` : '',
      cwd ? `<span class="pill" title="${esc(snap.cwd)}">📁 <b>${esc(cwd)}</b></span>` : '',
      snap.version ? `<span class="pill">v${esc(snap.version)}</span>` : '',
    ].join('');
  };

  /* ---------- header ---------- */
  function buildHeader() {
    $('mc-header').innerHTML =
      `<h1>AGENT MISSION CONTROL</h1><div class="live"><span class="dot" id="mc-dot"></span><span id="mc-conn">CONNECTING</span></div>`
      + `<select id="mc-view" title="Look &amp; feel"></select>`
      + `<select id="mc-agents" title="Which agents to show">${Object.entries(MC.AGENT_MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`
      + `<div id="mc-sw"><button id="mc-sbtn" title="Sessions: running, finished and past ones (replay too)"></button><div id="mc-spop" hidden>`
      +   `<div class="sp-top"><button id="mc-follow" title="Always show the most recently active session">⟳ Follow latest</button>`
      +   `<input id="mc-sq" type="search" placeholder="filter by title, prompt or folder…" autocomplete="off"></div><div id="mc-slist"></div></div></div>`
      + `<div id="mc-rp" hidden><span class="lbl">⏵ PLAYBACK</span><button id="rp-pp" title="Pause / resume">⏸</button>`
      + `<select id="rp-speed" title="Speed"><option value="1">1x</option><option value="4">4x</option><option value="16">16x</option><option value="64">64x</option></select>`
      + `<div id="rp-bar"><i></i></div><span id="rp-prog" class="pill"></span><button id="rp-re" title="Restart">⟲</button><button id="rp-x" title="Close playback">✕</button></div>`
      + `<div class="sp"></div><button id="mc-wait" hidden title="Agents waiting for you in the terminal. Click to jump to the oldest."></button><span id="mc-extra"></span><button id="mc-demo">▶ Demo</button>`
      + `<button id="mc-clear">Clear</button><button id="mc-bell" title="Browser notification when an agent needs you"></button>`
      + `<select id="mc-theme"><option value="neon">Neon</option><option value="amber">Amber CRT</option><option value="matrix">Matrix</option></select>`;
    $('mc-theme').value = S.theme; $('rp-speed').value = String(S.speed);
    $('mc-theme').onchange = e => applyTheme(e.target.value);
    $('mc-agents').value = S.agentMode;
    $('mc-agents').onchange = e => { S.agentMode = e.target.value; lsSet('mc-agents', S.agentMode); filtCache = null; refresh(false); };
    initPicker();
    $('mc-demo').onclick = () => { setSel('auto'); fetch('/api/demo'); };
    $('mc-clear').onclick = () => fetch('/api/clear');
    $('mc-wait').onclick = () => jumpToWait();
    $('mc-bell').onclick = async () => {
      if (!('Notification' in window)) return alert('This browser has no notifications.');
      if (S.alerts) { S.alerts = false; }
      else { if (Notification.permission === 'default') await Notification.requestPermission(); S.alerts = Notification.permission === 'granted';
        if (!S.alerts) alert('Notifications are blocked for this page in the browser settings.'); }
      lsSet('mc-alerts', S.alerts ? 'on' : 'off'); bellUI();
    };
    bellUI();
    const rpId = () => (MC.cur() && MC.cur().replay) ? MC.cur().id : null;
    $('rp-pp').onclick = () => { const c = MC.cur(); if (c && c.replay) post('/api/replay/control', { id: c.id, action: c.replay.paused ? 'resume' : 'pause' }); };
    $('rp-speed').onchange = e => { S.speed = Number(e.target.value); const id = rpId(); if (id) post('/api/replay/control', { id, action: 'speed', speed: S.speed }); };
    $('rp-re').onclick = () => { const id = rpId(); if (id) post('/api/replay/control', { id, action: 'restart' }); };
    $('rp-x').onclick = () => { const id = rpId(); if (id) { post('/api/replay/control', { id, action: 'stop' }); setSel('auto'); } };
  }
  /* ---------- session picker: one place for running, finished, replays and past sessions on disk ---------- */
  // working = some agent is busy · waiting = an agent needs you in the terminal · idle = live, waiting for your next prompt · ended
  MC.sessState = s => s.replay ? 'replay' : (s.waiting || []).length ? 'waiting' : !s.live ? 'ended'
    : s.agents.some(a => ['running', 'thinking', 'delegating'].includes(MC.effStatus(a, s))) ? 'working' : 'idle';
  const SICON = { waiting: '⏸', working: '●', idle: '◌', ended: '○', replay: '⏵' };
  const P = { past: [], at: 0, q: '' };
  const ago = t => t ? MC.fmtD(Date.now() - t) + ' ago' : '';
  const folder = p => (p || '').split(/[\\/]/).filter(Boolean).slice(-1)[0] || '';
  const projName = d => (d || '').replace(/^[A-Za-z]--/, '').replace(/^.*?-(?=[^-]+$)/, '') || d;    // "D--Work-sdlc" -> "sdlc" (best effort)
  function initPicker() {
    const pop = $('mc-spop');
    $('mc-sbtn').onclick = () => { pop.hidden = !pop.hidden; if (!pop.hidden) { renderPicker(); loadPast(); $('mc-sq').focus(); } };
    $('mc-follow').onclick = () => { setSel('auto'); refresh(true); pop.hidden = true; };
    $('mc-sq').oninput = e => { P.q = e.target.value.toLowerCase(); renderPicker(); };
    document.addEventListener('mousedown', e => { if (!pop.hidden && !$('mc-sw').contains(e.target)) pop.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') pop.hidden = true; });
    $('mc-slist').onclick = async e => {
      const b = e.target.closest('[data-rp],[data-sid],[data-open]'); if (!b) return;
      if (b.dataset.rp) { const j = await post('/api/replay', { file: b.dataset.rp, speed: S.speed }); if (j.error) return alert(j.error); setSel(j.id); }
      else if (b.dataset.sid) setSel(b.dataset.sid);
      else { const j = await post('/api/open', { file: b.dataset.open }); if (j.error) return alert(j.error); setSel(j.id); }
      pop.hidden = true; refresh(true);
    };
  }
  async function loadPast() {
    if (Date.now() - P.at < 4000) return; P.at = Date.now();
    try { P.past = await (await fetch('/api/sessions?n=80')).json(); } catch {}
    renderPicker();
  }
  function sessRow(s, curId) {
    const st = MC.sessState(s), a = s.agents, subs = a.filter(x => x.id !== 'main'), nw = (s.waiting || []).length;
    const busy = subs.filter(x => MC.ACTIVE.includes(MC.effStatus(x, s))).length;
    const meta = [folder(s.cwd),
      nw ? `<b class="w">${nw} waiting on you</b>` : '',
      st === 'replay' ? (s.replay.done ? 'playback finished' : `playback ${s.replay.i}/${s.replay.n}`) : '',
      subs.length ? (busy ? `<b>${busy}</b> of ${subs.length} agents busy` : `${subs.length} agent${subs.length > 1 ? 's' : ''}`) : '',
      s.cost && s.cost.usd != null ? '$' + s.cost.usd.toFixed(2) : '',
      st === 'ended' ? 'ended ' + ago(s.last) : st === 'replay' ? '' : 'active ' + ago(s.last)].filter(Boolean).join(' · ');
    return `<div class="srow ${st}${s.id === curId ? ' cur' : ''}" data-sid="${esc(s.id)}" title="${esc(s.title || '')}"><span class="si">${SICON[st]}</span>`
      + `<div class="sb"><div class="stt">${esc(s.title || (s.demo ? 'Demo' : 'Untitled session'))}</div><div class="sm">${meta}</div></div>`
      + (s.file && !s.replay ? `<button data-rp="${esc(s.file)}" title="Replay this session step by step">⏵ replay</button>` : '') + `</div>`;
  }
  function renderPicker() {
    const pop = $('mc-spop'); if (!pop || pop.hidden) return;
    $('mc-follow').classList.toggle('on', S.sel === 'auto');
    const cur = MC.rawCur(), curId = S.sel === 'auto' ? null : cur && cur.id, q = P.q;
    const hit = (...xs) => !q || xs.some(x => (x || '').toLowerCase().includes(q));
    const snaps = [...S.snaps.values()].filter(s => hit(s.title, s.cwd, s.id)).sort((a, b) => b.last - a.last);
    const groups = [
      ['RUNNING NOW', snaps.filter(s => ['waiting', 'working'].includes(MC.sessState(s))).sort((a, b) => (MC.sessState(a) === 'waiting' ? 0 : 1) - (MC.sessState(b) === 'waiting' ? 0 : 1) || b.last - a.last)],
      ['IDLE · WAITING FOR A PROMPT', snaps.filter(s => MC.sessState(s) === 'idle')],
      ['PLAYBACK', snaps.filter(s => s.replay)],
      ['ENDED', snaps.filter(s => MC.sessState(s) === 'ended')],
    ];
    const loaded = new Set(snaps.map(s => s.id).concat([...S.snaps.keys()]));
    const past = P.past.filter(p => !loaded.has(p.id) && hit(p.title, p.prompt, p.cwd, p.project));
    let h = groups.filter(([, l]) => l.length).map(([t, l]) => `<div class="sg">${t} <span>${l.length}</span></div>` + l.map(s => sessRow(s, curId)).join('')).join('');
    h += `<div class="sg">PAST SESSIONS ON DISK <span>${past.length}</span></div>`
      + (past.length ? past.map(p => `<div class="srow past" data-open="${esc(p.path)}" title="${esc(p.prompt || '')}"><span class="si">○</span><div class="sb">`
        + `<div class="stt">${esc(p.title || p.prompt || 'Untitled session')}</div><div class="sm">${esc(folder(p.cwd) || projName(p.project))} · ${esc(ago(p.mtime))} · ${MC.fmtK(p.size)}B</div></div>`
        + `<button data-rp="${esc(p.path)}" title="Replay this session step by step">⏵ replay</button></div>`).join('')
        : `<div class="sm" style="padding:6px 12px">${P.at ? 'nothing else' : 'loading…'}</div>`);
    $('mc-slist').innerHTML = h;
  }
  async function fillViews() {
    let list = []; try { list = await (await fetch('/api/views')).json(); } catch {}
    const sel = $('mc-view'); sel.innerHTML = list.map(v => `<option value="${esc(v.id)}" title="${esc(v.description)}">View: ${esc(v.name)}</option>`).join('');
    sel.value = MC.view.id;
    sel.onchange = e => { lsSet('mc-view', e.target.value); location.href = '/v/' + e.target.value; };
    // on the bare "/" URL, open the view the user picked last time
    const saved = lsGet('mc-view');
    if (location.pathname === '/' && saved && saved !== MC.view.id && list.some(v => v.id === saved)) location.replace('/v/' + saved);
  }
  function updateReplayUI(c) {
    const box = $('mc-rp'), r = c && c.replay; box.hidden = !r; if (!r) return;
    $('rp-pp').textContent = r.done ? '✓' : r.paused ? '▶' : '⏸'; $('rp-pp').disabled = r.done;
    $('rp-speed').value = String(r.speed); $('rp-prog').textContent = r.done ? 'finished' : `${r.i}/${r.n}`;
    $('rp-bar').firstChild.style.width = (r.n ? r.i / r.n * 100 : 0) + '%';
  }
  // header button: the session on screen, plus how many are running elsewhere
  function updateSessSelect() {
    const c = MC.rawCur(), all = [...S.snaps.values()], st = c ? MC.sessState(c) : '';
    const running = all.filter(s => ['working', 'waiting'].includes(MC.sessState(s))).length;
    $('mc-sbtn').innerHTML = (S.sel === 'auto' ? '<span class="fl" title="following the latest session">⟳</span>' : '')
      + (c ? `<span class="si ${st}">${SICON[st]}</span><span class="stt">${esc(c.title || (c.demo ? 'Demo' : 'Untitled session'))}</span>` : '<span class="stt">no session</span>')
      + (running ? `<span class="cnt">${running} running</span>` : '') + '<span class="car">▾</span>';
    renderPicker();
  }
  function applyTheme(t) {
    S.theme = t; document.documentElement.dataset.theme = t; if ($('mc-theme')) $('mc-theme').value = t; lsSet('mc-theme', t);
    for (const s of S.snaps.values()) delete s._ci;
    if (MC.view && MC.view.onTheme) MC.view.onTheme();
  }

  /* ---------- "waiting on you": header chip, tab title, browser notifications ---------- */
  // agents blocked on you, plus one "your turn" entry per session whose run is over (those sort last, so jumps go to real blocks first)
  const allWaits = () => [...S.snaps.values()].filter(s => !s.replay).flatMap(s => {
    const ws = (s.waiting || []).map(w => ({ ...w, sid: s.id, snap: s })), t = MC.yourTurn(s);
    if (t) ws.push({ key: s.id + '|turn|' + t, aid: 'user', kind: 'turn', since: t, sid: s.id, snap: s });
    return ws;
  }).sort((a, b) => (a.kind === 'turn') - (b.kind === 'turn') || a.since - b.since);
  function bellUI() { const b = $('mc-bell'); if (!b) return; b.textContent = S.alerts ? '🔔' : '🔕'; b.classList.toggle('on', !!S.alerts); }
  function jumpToWait(w) {
    w = w || allWaits()[0]; if (!w) return;
    if (MC.rawCur() !== S.snaps.get(w.sid)) { setSel(w.sid); refresh(true); }
    if (MC.view && MC.view.onFocusAgent) MC.view.onFocusAgent(w.aid);
  }
  MC.waitLabel = w => w.kind === 'question' ? 'asking' : 'needs approval' + (w.tool ? ': ' + w.tool : '');
  function updateWaits() {
    const list = allWaits(), btn = $('mc-wait'); if (!btn) return;
    const nt = list.filter(w => w.kind === 'turn').length, nb = list.length - nt;
    const label = [nb ? `⏸ ${nb} waiting` : '', nt ? `▶ your turn${nt > 1 ? ` (${nt})` : ''}` : ''].filter(Boolean).join(' · ');
    btn.hidden = !list.length; btn.textContent = label; btn.classList.toggle('turn', !nb && !!nt);
    document.title = (list.length ? `(${label}) ` : '') + S.baseTitle;
    const keys = new Set(list.map(w => w.key));
    if (S.seenWaits) for (const w of list) if (!S.seenWaits.has(w.key)) notify(w);
    for (const k of [...N.sys.keys(), ...N.toasts.keys()]) if (!keys.has(k)) resolved(k);
    for (const w of list) { const t = N.toasts.get(w.key); if (t) t.querySelector('[data-t=w]').textContent = MC.fmtD(Date.now() - w.since); }
    S.seenWaits = keys;                     // the first snapshot after (re)connecting only primes this, so old waits don't re-alert
  }

  /* what to say about one wait: shared by the in-page toast and the system notification */
  function waitInfo(w) {
    const s = w.snap, where = (s.cwd || '').split(/[\\/]/).filter(Boolean).slice(-1)[0] || '';
    if (w.kind === 'turn') {
      const m = s.agents.find(x => x.id === 'main'), n = s.agents.length - 1;
      return { turn: true, name: 'Claude', color: MC.TURN, head: 'finished' + (n ? ` (${n} agent${n > 1 ? 's' : ''} done)` : '') + ' · your turn', tool: '',
        detail: ((m && m.text) || '').slice(0, 300), options: [], where, title: s.title || '' };
    }
    const a = (s.agents || []).find(x => x.id === w.aid), q = w.kind === 'question';
    const qs = (w.questions || [])[0];
    return { q, name: a ? MC.nameMap(s).get(a.id) : 'agent', color: MC.colorOf(s.id, w.aid),
      head: q ? 'is asking you' : 'needs approval', tool: q ? '' : w.tool || '',
      detail: q && qs ? qs.q : w.text || '', options: q && qs ? qs.options.map(o => o.label) : [],
      where: (s.cwd || '').split(/[\\/]/).filter(Boolean).slice(-1)[0] || '', title: s.title || '' };
  }
  // 128px icon drawn on the fly: dark tile, ring in the agent's colour, amber pause bars (approval), question mark, or green play (your turn)
  function waitIcon(color, q, turn) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), W8 = '#ffb02e';
      g.fillStyle = '#0a0f1a'; g.beginPath(); g.roundRect(0, 0, 128, 128, 28); g.fill();
      g.lineWidth = 9; g.strokeStyle = color; g.beginPath(); g.arc(64, 64, 46, 0, 7); g.stroke();
      const F = turn ? MC.TURN : W8; g.fillStyle = F; g.shadowColor = F; g.shadowBlur = 14;
      if (turn) { g.beginPath(); g.moveTo(50, 38); g.lineTo(88, 64); g.lineTo(50, 90); g.closePath(); g.fill(); }
      else if (q) { g.font = '900 68px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', 64, 68); }
      else { g.beginPath(); g.roundRect(43, 38, 15, 52, 4); g.roundRect(70, 38, 15, 52, 4); g.fill(); }
      return c.toDataURL('image/png');
    } catch { return undefined; }
  }
  const N = { sys: new Map(), toasts: new Map() };
  function notify(w) {
    const i = waitInfo(w);
    toast(w, i);                                           // in-page card, always
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    if (focused || !S.alerts || !('Notification' in window) || Notification.permission !== 'granted') return;
    const body = [i.tool ? `${i.tool} · ${i.detail}` : i.detail,
      i.options.length ? i.options.map((o, n) => `${n + 1}. ${o}`).join('   ') : '',
      [i.where && '📁 ' + i.where, i.title].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    try {
      const n = new Notification(`${i.turn ? '▶' : i.q ? '❓' : '⏸'} ${i.name} ${i.head}${i.tool ? ' · ' + i.tool : ''}`,
        { body, icon: waitIcon(i.color, i.q, i.turn), tag: w.key, requireInteraction: !i.turn });
      n.onclick = () => { window.focus(); jumpToWait(w); n.close(); };
      n.onclose = () => N.sys.delete(w.key);
      N.sys.set(w.key, n);
    } catch {}
  }
  function toast(w, i) {
    let box = $('mc-toasts'); if (!box) { box = document.createElement('div'); box.id = 'mc-toasts'; document.body.append(box); }
    const t = document.createElement('div'); t.className = 'toast' + (i.q ? ' q' : '') + (i.turn ? ' turn' : ''); t.style.setProperty('--c', i.color);
    t.innerHTML = `<img alt="" src="${waitIcon(i.color, i.q, i.turn) || ''}"><div class="tb">`
      + `<div class="th"><b class="tn">${esc(i.name)}</b> ${esc(i.head)}${i.tool ? ` <span class="tt">${esc(i.tool)}</span>` : ''}<span class="tw" data-t="w">0s</span></div>`
      + (i.detail ? `<div class="td">${esc(i.detail)}</div>` : '')
      + (i.options.length ? `<div class="to">${i.options.map((o, n) => `<span>${n + 1}. ${esc(o)}</span>`).join('')}</div>` : '')
      + `<div class="tf"><span>${esc([i.where && '📁 ' + i.where, i.title].filter(Boolean).join(' · '))}</span>`
      + `<button data-a="show">Show</button><button data-a="x" title="Dismiss">✕</button></div></div>`;
    t.onclick = e => { const a = e.target.dataset.a; if (a === 'x') return drop(w.key); jumpToWait(w); };
    box.prepend(t); N.toasts.set(w.key, t);
    while (box.children.length > 4) { const last = box.lastChild; for (const [k, v] of N.toasts) if (v === last) N.toasts.delete(k); last.remove(); }
  }
  function drop(key, later) {
    const t = N.toasts.get(key); if (!t) return; N.toasts.delete(key);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, later || 0);
  }
  // the agent got its answer (in the terminal): close the system notification, let the toast say so briefly
  function resolved(key) {
    const n = N.sys.get(key); if (n) { try { n.close(); } catch {} N.sys.delete(key); }
    if (key.includes('|turn|')) return drop(key);          // you typed, or the session went quiet: nothing to confirm
    const t = N.toasts.get(key); if (t) { t.classList.add('done'); const h = t.querySelector('.tw'); if (h) h.textContent = '✓ answered'; drop(key, 2500); }
  }

  /* ---------- collapsible sections ---------- */
  // <section class="fold" data-fold="key"><h2>…</h2>…</section>: clicking the title hides the rest of the section (remembered per browser)
  MC.initFolds = () => document.querySelectorAll('.fold[data-fold]').forEach(sec => {
    const h = sec.querySelector('h2'), k = 'mc-fold-' + sec.dataset.fold;
    const set = shut => { sec.classList.toggle('shut', shut); lsSet(k, shut ? '1' : '0'); };
    set(lsGet(k) === '1');
    h.addEventListener('click', e => { if (!e.target.closest('button,select,input,#filter')) set(!sec.classList.contains('shut')); });
  });

  /* ---------- usage panel: tools, MCP, skills, agents, commands, hooks ---------- */
  const UCATS = [['all', 'all'], ['tool', 'tools'], ['mcp', 'mcp'], ['skill', 'skills'], ['agent', 'agents'], ['command', 'commands'], ['hook', 'hooks']];
  const fmtMs = ms => ms < 1000 ? Math.round(ms) + 'ms' : MC.fmtD(ms);
  MC.usagePanel = el => {
    const P = { mode: lsGet('mc-us-mode') === 'all' ? 'all' : 'session', cat: 'all', open: new Set(), cross: null, crossKey: '', busy: false, err: '', sig: '',
      where: lsGet('mc-us-where') === '*' ? '*' : 'project', days: lsGet('mc-us-days') || '30' };
    el.innerHTML = `<div class="us-ctl"><button data-m="session">THIS SESSION</button><button data-m="all">ALL SESSIONS</button>
      <span class="us-x"><select data-k="where"><option value="project">this project</option><option value="*">all projects</option></select>
      <select data-k="days"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="0">all time</option></select>
      <button data-k="reload" title="Rescan transcripts">↻</button></span></div><div class="us-cats"></div><div class="us-body"></div>`;
    const q = s => el.querySelector(s), body = q('.us-body');
    q('[data-k=where]').value = P.where; q('[data-k=days]').value = P.days;
    const redraw = () => { P.sig = ''; P.draw(MC.cur()); };
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { P.mode = b.dataset.m; lsSet('mc-us-mode', P.mode); redraw(); });
    q('[data-k=where]').onchange = e => { P.where = e.target.value; lsSet('mc-us-where', P.where); redraw(); };
    q('[data-k=days]').onchange = e => { P.days = e.target.value; lsSet('mc-us-days', P.days); redraw(); };
    q('[data-k=reload]').onclick = () => { P.crossKey = ''; redraw(); };
    q('.us-cats').onclick = e => { const b = e.target.closest('[data-c]'); if (b) { P.cat = b.dataset.c; redraw(); } };
    body.onclick = e => { const r = e.target.closest('tr[data-k]'); if (r) { const k = r.dataset.k; P.open.has(k) ? P.open.delete(k) : P.open.add(k); redraw(); } };
    const scopeOf = snap => P.where === '*' || !snap || !snap.file ? '*' : snap.file.split(/[\\/]/).slice(-2, -1)[0];
    function load(key, scope) {
      P.busy = true; P.err = '';
      fetch(`/api/usage?scope=${encodeURIComponent(scope)}&days=${P.days}`).then(r => r.json()).then(d => { if (d.error) throw new Error(d.error); P.cross = d; })
        .catch(e => { P.err = String(e.message || e); P.cross = null; }).finally(() => { P.busy = false; P.crossKey = key; redraw(); });
    }
    function data(snap) {
      if (P.mode === 'session') {
        if (!snap) return null; const names = MC.nameMap(snap);
        return { rows: snap.usage || [], avail: snap.avail || {}, who: id => id === 'user' ? 'you' : names.get(id) || id,
          note: 'usage' in snap ? '' : '⚠ the server is older than this page: restart it (node server.js) to see usage' };
      }
      const scope = scopeOf(snap), key = scope + '|' + P.days;
      if (key !== P.crossKey && !P.busy) load(key, scope);
      const c = P.cross, note = P.busy ? 'scanning transcripts…' : P.err ? '⚠ ' + P.err : c ? `${c.sessions} session${c.sessions === 1 ? '' : 's'} · ${c.projects} project${c.projects === 1 ? '' : 's'} · ${scope === '*' ? 'all projects' : 'this project'}` : '';
      return { rows: c ? c.rows : [], avail: c ? c.avail : {}, who: id => id === 'user' ? 'you' : id, note, cross: true };
    }
    P.draw = snap => {
      el.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === P.mode)); q('.us-x').hidden = P.mode !== 'all';
      const d = data(snap);
      const sig = d ? [P.mode, P.cat, [...P.open], d.note, d.rows.map(r => r.name + r.calls + '/' + r.errs + '/' + r.timed), Object.values(d.avail).map(v => v.length)].join('|') : '';
      if (sig === P.sig) return; P.sig = sig;
      if (!d) { q('.us-cats').innerHTML = ''; body.innerHTML = '<div class="us-note">no session</div>'; return; }
      const cnt = c => d.rows.filter(r => c === 'all' || r.cat === c).reduce((s, r) => s + r.calls, 0);
      q('.us-cats').innerHTML = UCATS.filter(([c]) => c === 'all' || cnt(c)).map(([c, l]) => `<button data-c="${c}" class="${P.cat === c ? 'on' : ''}">${l} <b>${cnt(c)}</b></button>`).join('');
      const rows = d.rows.filter(r => P.cat === 'all' || r.cat === P.cat).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
      const byTxt = (r, n) => Object.entries(r.by).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w, k]) => `${esc(d.who(w))} <b>${k}</b>`).join(' · ');
      let h = d.note ? `<div class="us-note">${esc(d.note)}</div>` : '';
      h += rows.length ? `<table class="us-t"><tr><th>NAME</th><th>CALLS</th><th>ERR</th><th>AVG</th><th>CALLED BY</th></tr>` + rows.map(r => {
        const k = r.cat + '|' + r.name, open = P.open.has(k);
        const row = `<tr data-k="${esc(k)}" class="${open ? 'open' : ''}"><td title="${esc(r.name)}"><span class="us-c us-${r.cat}">${r.cat}</span>${esc(r.name)}${r.src ? ` <span class="us-src">${esc(r.src)}</span>` : ''}</td>
          <td><b>${r.calls}</b></td><td class="${r.errs ? 'us-err' : ''}">${r.errs || ''}</td><td>${r.timed ? fmtMs(r.ms / r.timed) : '—'}</td><td>${byTxt(r, 2)}</td></tr>`;
        return open ? row + `<tr class="us-more"><td colspan="5">called by: ${byTxt(r, 99)}<br>total time ${r.timed ? fmtMs(r.ms) : '—'} · first ${new Date(r.first).toLocaleString()} · last ${new Date(r.last).toLocaleString()}${d.cross ? ` · in ${r.sessions} session${r.sessions === 1 ? '' : 's'}` : ''}</td></tr>` : row;
      }).join('') + '</table>' : `<div class="us-note">${P.mode === 'all' && P.busy ? '' : 'nothing used yet'}</div>`;
      // loaded but never called: skills (a skill run as /plugin:skill counts as used), agent types, deferred tools, MCP servers
      const used = new Set(d.rows.map(r => r.cat + '|' + r.name)), un = [];
      for (const c of ['skill', 'agent', 'tool']) if (P.cat === 'all' || P.cat === c) {
        const l = (d.avail[c] || []).filter(n => !used.has(c + '|' + n) && !used.has('command|/' + n)); if (l.length) un.push([c, l.map(esc)]);
      }
      if ((P.cat === 'all' || P.cat === 'mcp') && d.avail.mcp) {
        const srv = new Map(); for (const n of d.avail.mcp) { const s = n.split(' · ')[0], x = srv.get(s) || { n: 0, u: 0 }; x.n++; if (used.has('mcp|' + n)) x.u++; srv.set(s, x); }
        const l = [...srv].filter(([, x]) => x.u < x.n).map(([s, x]) => `${esc(s)} <b>${x.u}/${x.n}</b>`); if (l.length) un.push(['mcp', l]);
      }
      if (un.length) h += `<details class="us-un"><summary>loaded but never used · ${un.map(([c, l]) => c + ' ' + l.length).join(' · ')}</summary>` +
        un.map(([c, l]) => `<div><span class="us-c us-${c}">${c}</span>${l.map(x => `<span class="us-chip">${x}</span>`).join('')}</div>`).join('') + '</details>';
      const det = body.querySelector('.us-un'), wasOpen = det && det.open, st = body.scrollTop;
      body.innerHTML = h; const nd = body.querySelector('.us-un'); if (nd && wasOpen) nd.open = true; body.scrollTop = st;
    };
    return P;
  };

  /* ---------- plumbing ---------- */
  function refresh(sessionChanged) {
    const c = MC.cur(); updateSessSelect(); updateReplayUI(c);
    const v = MC.view; if (!v) return;
    if (sessionChanged || (c ? c.id : null) !== S.curId) { S.curId = c ? c.id : null; if (v.onSession) v.onSession(c); }
    if (v.onSnap) v.onSnap(c, S.snaps);
  }
  function connect() {
    const es = new EventSource('/stream');
    es.onopen = () => { $('mc-dot').className = 'dot on'; $('mc-conn').textContent = 'LIVE'; };
    es.onerror = () => { $('mc-dot').className = 'dot'; $('mc-conn').textContent = 'RECONNECTING'; };
    es.onmessage = m => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d.t === 'hello') { S.snaps.clear(); S.events.clear(); S.curId = null; S.seenWaits = null; if (MC.view && MC.view.onReset) MC.view.onReset(); }
      else if (d.t === 'snap') { const t = Date.now(); S.snaps = new Map(d.sessions.map(s => (s._rcv = t, [s.id, s]))); refresh(false); updateWaits(); }
      else if (d.t === 'ev') {
        let l = S.events.get(d.session); if (!l) S.events.set(d.session, l = []); l.push(d); if (l.length > 20000) l.shift();
        const c = MC.cur(); if (c && c.id === d.session && MC.view && MC.view.onEvent) MC.view.onEvent(d, c);
      }
    };
  }
  MC.start = view => {
    MC.view = view; S.baseTitle = document.title; S.alerts = lsGet('mc-alerts') === 'on' && 'Notification' in window && Notification.permission === 'granted'; S.theme = lsGet('mc-theme') || 'neon'; S.agentMode = MC.AGENT_MODES[lsGet('mc-agents')] ? lsGet('mc-agents') : 'all'; S.sel = ssGet('mc-sel') || 'auto'; document.documentElement.dataset.theme = S.theme;
    buildHeader(); fillViews(); connect();
    setInterval(() => { const c = MC.cur(); updateReplayUI(c);
      for (const w of allWaits()) { const t = N.toasts.get(w.key), el = t && t.querySelector('.tw'); if (el && !t.classList.contains('done')) el.textContent = MC.fmtD(Date.now() - w.since); } if (MC.view.onTick) MC.view.onTick(c); }, 1000);
  };
  MC.refresh = refresh;
})();
