// Mission Control core: everything a "view" needs so that a view only has to draw.
//
// A view is a file views/<id>.html that includes /core.css and /core.js, has <header id="mc-header"></header>,
// and calls MC.start({ id, onSnap, onEvent, onSession, onReset, onTheme }):
//   onSnap(snap, all)   the current session's state changed (snap = {title, agents:[...], replay, live, ...})
//   onEvent(ev, snap)   one live/replayed message: kind = prompt | handoff | result | tool | text
//   onSession(snap)     the user switched to a different session: reset your view-local state
//   onReset()           server cleared everything
//   onTheme()           colour theme changed
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
  const ACTIVE = ['running', 'thinking', 'delegating'];
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
    const active = a.filter(x => x.id !== 'main' && ['running', 'thinking', 'delegating'].includes(MC.effStatus(x, snap))).length;
    const cwd = (snap.cwd || '').split(/[\\/]/).slice(-2).join('/');
    return [
      `<span class="title" title="${esc(snap.title)}">${esc(snap.title || 'Untitled session')}</span>`,
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
      + `<select id="mc-sess" title="Session"><option value="auto">⟳ Follow latest session</option></select>`
      + `<div id="mc-rp" hidden><span class="lbl">⏵ PLAYBACK</span><button id="rp-pp" title="Pause / resume">⏸</button>`
      + `<select id="rp-speed" title="Speed"><option value="1">1x</option><option value="4">4x</option><option value="16">16x</option><option value="64">64x</option></select>`
      + `<div id="rp-bar"><i></i></div><span id="rp-prog" class="pill"></span><button id="rp-re" title="Restart">⟲</button><button id="rp-x" title="Close playback">✕</button></div>`
      + `<div class="sp"></div><span id="mc-extra"></span><button id="mc-demo">▶ Demo</button>`
      + `<select id="mc-replay" title="Step-by-step playback of a past session"><option value="">⏵ Replay past session…</option></select>`
      + `<select id="mc-openf" title="Show a past session's final state"><option value="">📂 Open final state…</option></select>`
      + `<button id="mc-clear">Clear</button>`
      + `<select id="mc-theme"><option value="neon">Neon</option><option value="amber">Amber CRT</option><option value="matrix">Matrix</option></select>`;
    $('mc-theme').value = S.theme; $('rp-speed').value = String(S.speed);
    $('mc-theme').onchange = e => applyTheme(e.target.value);
    $('mc-agents').value = S.agentMode;
    $('mc-agents').onchange = e => { S.agentMode = e.target.value; lsSet('mc-agents', S.agentMode); filtCache = null; refresh(false); };
    $('mc-sess').onchange = e => { setSel(e.target.value); refresh(true); };
    $('mc-demo').onclick = () => { setSel('auto'); fetch('/api/demo'); };
    $('mc-clear').onclick = () => fetch('/api/clear');
    for (const id of ['mc-replay', 'mc-openf']) $(id).onfocus = fillPast;
    $('mc-replay').onchange = async e => { const f = e.target.value; e.target.value = ''; if (!f) return;
      const j = await post('/api/replay', { file: f, speed: S.speed }); if (j.error) alert(j.error); else { setSel(j.id); refresh(true); } };
    $('mc-openf').onchange = async e => { const f = e.target.value; e.target.value = ''; if (!f) return;
      const j = await post('/api/open', { file: f }); if (j.error) alert(j.error); else { setSel(j.id); refresh(true); } };
    const rpId = () => (MC.cur() && MC.cur().replay) ? MC.cur().id : null;
    $('rp-pp').onclick = () => { const c = MC.cur(); if (c && c.replay) post('/api/replay/control', { id: c.id, action: c.replay.paused ? 'resume' : 'pause' }); };
    $('rp-speed').onchange = e => { S.speed = Number(e.target.value); const id = rpId(); if (id) post('/api/replay/control', { id, action: 'speed', speed: S.speed }); };
    $('rp-re').onclick = () => { const id = rpId(); if (id) post('/api/replay/control', { id, action: 'restart' }); };
    $('rp-x').onclick = () => { const id = rpId(); if (id) { post('/api/replay/control', { id, action: 'stop' }); setSel('auto'); } };
  }
  async function fillPast() {
    let list = []; try { list = await (await fetch('/api/sessions')).json(); } catch {}
    for (const id of ['mc-replay', 'mc-openf']) {
      const sel = $(id), first = sel.options[0].outerHTML;
      sel.innerHTML = first + list.map(s => `<option value="${esc(s.path)}">${esc(new Date(s.mtime).toLocaleString() + ' · ' + s.project.replace(/^[A-Za-z]--/, '').slice(-30))}</option>`).join('');
    }
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
  function updateSessSelect() {
    const sel = $('mc-sess'), list = [...S.snaps.values()].sort((a, b) => b.last - a.last);
    sel.innerHTML = '<option value="auto">⟳ Follow latest session</option>' + list.map(s =>
      `<option value="${esc(s.id)}">${s.replay ? '⏵ ' : s.live ? '● ' : ''}${esc((s.title || 'Untitled').slice(0, 38))} · ${esc(s.id.replace(/^replay-/, '').slice(0, 8))}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === S.sel) ? S.sel : 'auto';
  }
  function applyTheme(t) {
    S.theme = t; document.documentElement.dataset.theme = t; if ($('mc-theme')) $('mc-theme').value = t; lsSet('mc-theme', t);
    for (const s of S.snaps.values()) delete s._ci;
    if (MC.view && MC.view.onTheme) MC.view.onTheme();
  }

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
      if (d.t === 'hello') { S.snaps.clear(); S.events.clear(); S.curId = null; if (MC.view && MC.view.onReset) MC.view.onReset(); }
      else if (d.t === 'snap') { const t = Date.now(); S.snaps = new Map(d.sessions.map(s => (s._rcv = t, [s.id, s]))); refresh(false); }
      else if (d.t === 'ev') {
        let l = S.events.get(d.session); if (!l) S.events.set(d.session, l = []); l.push(d); if (l.length > 20000) l.shift();
        const c = MC.cur(); if (c && c.id === d.session && MC.view && MC.view.onEvent) MC.view.onEvent(d, c);
      }
    };
  }
  MC.start = view => {
    MC.view = view; S.theme = lsGet('mc-theme') || 'neon'; S.agentMode = MC.AGENT_MODES[lsGet('mc-agents')] ? lsGet('mc-agents') : 'all'; S.sel = ssGet('mc-sel') || 'auto'; document.documentElement.dataset.theme = S.theme;
    buildHeader(); fillViews(); connect();
    setInterval(() => { const c = MC.cur(); updateReplayUI(c); if (MC.view.onTick) MC.view.onTick(c); }, 1000);
  };
  MC.refresh = refresh;
})();
