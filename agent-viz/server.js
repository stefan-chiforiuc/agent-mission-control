// Agent Mission Control - zero-dependency server (v2).
// Hooks only "ring the doorbell" (tell us a session exists / something happened);
// the real data (tokens, model, effort, sub-agent tree, messages) is read live
// from Claude Code's own transcript files, incrementally.
//
// Usage: node server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const U = require('./usage');

const PORT = Number(process.argv[2] || process.env.PORT || 7777);
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const clients = new Set();
const history = new Map();     // session id -> events, replayed to new browser tabs (per session, so one session can't evict another's)
const HISTORY_MAX = 20000;
const sessions = new Map();    // session_id -> Session
const timers = new Set();      // demo timers
const raw = [];                // last raw hook payloads (debug: /api/raw)

const clip = (s, n = 600) => {
  if (s == null) return '';
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const sendAll = obj => { const d = `data: ${JSON.stringify(obj)}\n\n`; for (const c of clients) c.write(d); };

/* ------------------------------------------------------------------ */
/* Typical durations: Claude Code doesn't report progress of a running */
/* command, so we estimate it from how long the same kind of call took */
/* before (per project, falling back to all projects).                 */
/* ------------------------------------------------------------------ */
const DUR = new Map();          // scope (project folder | '*' | 'demo') -> Map(key -> last 40 durations in ms)
const DUR_SEEN = new Set();     // tool_use ids already counted (live reading, replays and the history scan overlap)
const learned = new Set();      // project folders whose history was scanned
// "cd x && npm test -- auth" -> "Bash:npm test"; "node run-me.js" -> "Bash:node"; Agent -> "agent:<type>"; anything else -> its tool name
function durKey(name, input) {
  input = input || {};
  if (input.run_in_background) return '';                     // returns at once; not a real duration
  if (name === 'Agent' || name === 'Task') return 'agent:' + (input.subagent_type || 'agent');
  if ((name === 'Bash' || name === 'PowerShell') && input.command) {
    let c = String(input.command).split(/\r?\n/)[0];
    c = c.replace(/^\s*((cd\s+("[^"]*"|'[^']*'|[^\s;&]+)|\w+=("[^"]*"|'[^']*'|[^\s;&]*))\s*(&&|;|\s|$)\s*)+/i, '');   // "cd x &&", "FOO=bar"
    const w = c.trim().split(/\s+/).filter(x => x && !x.startsWith('-')).slice(0, 2).map(x => x.replace(/^["'(]+|["')]+$/g, ''));
    if (w[1] && /[\/\\.:=$|&<>]/.test(w[1])) w.length = 1;      // a path or file, not a sub-command
    return w[0] ? name + ':' + w.join(' ').toLowerCase().slice(0, 60) : name;
  }
  return name;
}
// a result that measures the tool itself: not failed, rejected, waiting on a human approval, or started in the background
const durOk = (m, b) => { const d = m.permissionDecision || {}, r = m.toolUseResult;
  return !b.is_error && d.decision !== 'reject' && !/^user/.test(d.source || '') && !(r && typeof r === 'object' && (r.isAsync || r.backgroundTaskId)); };
const durScopes = scope => scope === 'demo' ? ['demo'] : [...new Set([scope || '*', '*'])];
function durAdd(scope, key, ms, id) {
  if (!key || !(ms >= 0) || ms > 6 * 3600e3) return;
  if (id) { if (DUR_SEEN.has(id)) return; if (DUR_SEEN.size > 300000) DUR_SEEN.clear(); DUR_SEEN.add(id); }
  for (const sc of durScopes(scope)) {
    let m = DUR.get(sc); if (!m) DUR.set(sc, m = new Map());
    let a = m.get(key); if (!a) m.set(key, a = []);
    a.push(ms); if (a.length > 40) a.shift();
  }
}
// median of the last runs (needs 2+); n = how many runs it is based on
function durEst(scope, key) {
  if (!key) return null;
  for (const sc of durScopes(scope)) {
    const a = DUR.get(sc) && DUR.get(sc).get(key);
    if (a && a.length >= 2) { const s = [...a].sort((x, y) => x - y); return { ms: s[Math.floor(s.length / 2)], n: a.length }; }
  }
  return null;
}
// once per project: read its newest transcripts in the background and pair every tool_use with its tool_result
async function learnProject(scope) {
  if (!scope || scope === '*' || scope === 'demo' || learned.has(scope)) return;
  learned.add(scope);
  const dir = path.join(PROJECTS, scope), files = [];
  try {
    for (const n of await fs.promises.readdir(dir)) {
      if (n.endsWith('.jsonl')) files.push(path.join(dir, n));
      else try { for (const m of await fs.promises.readdir(path.join(dir, n, 'subagents'))) if (m.endsWith('.jsonl')) files.push(path.join(dir, n, 'subagents', m)); } catch {}
    }
  } catch { return; }
  const st = []; for (const f of files) try { const x = await fs.promises.stat(f); if (x.size < 40e6) st.push([f, x.mtimeMs]); } catch {}
  st.sort((a, b) => b[1] - a[1]);
  for (const [f] of st.slice(0, 80)) {
    let txt; try { txt = await fs.promises.readFile(f, 'utf8'); } catch { continue; }
    const open = new Map(); let t0 = 0, t1 = 0;
    for (const l of txt.split('\n')) {
      const tm = /"timestamp":"([^"]+)"/.exec(l); if (tm) { const t = Date.parse(tm[1]); if (t) { if (!t0) t0 = t; t1 = t; } }
      if (!l.includes('"tool_use"') && !l.includes('"tool_result"')) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      const ts = Date.parse(m.timestamp), c = m.message && m.message.content; if (!ts || !Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === 'tool_use') { const key = durKey(b.name, b.input); if (key && !key.startsWith('agent:')) open.set(b.id, { key, ts }); }
        else if (b.type === 'tool_result') { const o = open.get(b.tool_use_id); if (o) { open.delete(b.tool_use_id); if (durOk(m, b)) durAdd(scope, o.key, ts - o.ts, b.tool_use_id); } }
      }
    }
    // a finished sub-agent's file spans its whole life: that is how long this agent type takes
    if (f.includes(path.sep + 'subagents' + path.sep) && t1 > t0) {
      const meta = readMeta(f.replace(/\.jsonl$/, '.meta.json'));
      if (meta && meta.agentType && meta.finished !== false) durAdd(scope, 'agent:' + meta.agentType, t1 - t0, 'life:' + f);
    }
    await new Promise(r => setImmediate(r));               // stay responsive while scanning
  }
  for (const s of sessions.values()) s.dirty = true;
}

/* ------------------------------------------------------------------ */
/* Session model: the single place that turns raw facts into state     */
/* ------------------------------------------------------------------ */
class Session {
  constructor(id) {
    Object.assign(this, { id, tp: null, title: '', cwd: '', branch: '', version: '', permissionMode: '', mode: '',
      first: 0, last: 0, cost: null, lastHook: 0, lastGrowth: 0, main: null, subs: new Map(), dirty: true, demo: false, rp: null });
    this.agents = new Map();
    this.waits = new Map();   // key -> { who, kind: 'approval' | 'question', tool, text, questions, tuid, since }: agent blocked on the human
    this.ended = new Set();   // background tasks known to be over (see shellDone)
    this.inv = new Map();     // usage: cat|name -> { cat, name, src, calls, errs, ms, timed, by: { agent id: n } }
    this.avail = {};          // what the session had loaded: cat -> Set(name)
    this.pre = new Map();     // tool_use_id -> still-open tool call from PreToolUse { who, tuid, tool, input, ts }  (who = 'main' or the hook's agent_id)
  }
  agent(id) {
    let a = this.agents.get(id);
    if (!a) {
      a = { id, parent: id === 'main' ? null : 'main', type: id === 'main' ? 'main' : 'agent', desc: '', model: '', effort: '',
        usage: new Map(), lastUsage: null, thinkMs: 0, tools: 0, toolMs: 0, first: 0, last: 0, end: null, finished: false, bg: false,
        pend: new Map(), shells: new Map(), recent: [], hist: {}, text: '', textTs: 0, task: '', result: '', lastKind: '' };
      this.agents.set(id, a);
    }
    return a;
  }
  stamp(a, ts) {
    if (!a.first || ts < a.first) a.first = ts;
    if (ts > a.last) a.last = ts;
    if (!this.first || ts < this.first) this.first = ts;
    if (ts > this.last) this.last = ts;
    this.dirty = true;
  }
  emit(ev) {
    ev = { t: 'ev', session: this.id, replay: !!this.rp, ...ev };
    let list = history.get(this.id); if (!list) history.set(this.id, list = []);
    list.push(ev); if (list.length > HISTORY_MAX) list.shift();
    sendAll(ev);
  }
  prompt(text, ts) {
    const a = this.agent('main'); this.stamp(a, ts); a.lastKind = 'prompt';
    this.emit({ ts, kind: 'prompt', from: 'user', to: 'main', agent: 'main', text: clip(text, 1500) });
  }
  usage(aid, msgId, u, model, effort, ts) {
    const a = this.agent(aid); this.stamp(a, ts);
    a.usage.set(msgId, u); a.lastUsage = u;
    if (model) a.model = model;
    if (effort) a.effort = effort;
  }
  thinking(aid, ms) { this.agent(aid).thinkMs += ms || 0; }
  text(aid, text, ts) {
    const a = this.agent(aid); this.stamp(a, ts);
    a.text = clip(text, 12000); a.textTs = ts; a.lastKind = 'text';
    this.emit({ ts, kind: 'text', agent: aid, text: clip(text, 700) });
  }
  endTurn(aid, ts) {
    const a = this.agent(aid); this.stamp(a, ts);
    if (!a.pend.size) a.lastKind = 'end';
    if (aid === 'main' && a.text) this.emit({ ts, kind: 'result', from: 'main', to: 'user', agent: 'main', text: clip(a.text, 700) });
  }
  toolUse(aid, b, ts) {
    const a = this.agent(aid); this.stamp(a, ts); a.tools++; a.hist[b.name] = (a.hist[b.name] || 0) + 1; a.lastKind = 'tool';
    const input = b.input || {}, inv = U.invAdd(this.inv, U.classify(b.name, input), aid, ts);
    if (b.name === 'TaskStop' || b.name === 'KillShell') this.shellDone(input.task_id || input.shell_id);   // TaskStop / KillShell: no notification follows
    if (b.name === 'Agent' || b.name === 'Task') {
      const cid = 'tu:' + b.id, c = this.agent(cid);
      c.parent = aid; c.type = input.subagent_type || c.type; c.desc = input.description || c.desc;
      c.task = clip(input.prompt, 12000); this.stamp(c, ts); c.key = durKey(b.name, input);
      a.pend.set(b.id, { name: b.name, summary: c.type, ts, child: cid, key: c.key, inv });
      this.emit({ ts, kind: 'handoff', from: aid, to: cid, agent: aid, text: clip(input.prompt || input.description, 1500) });
    } else {
      const summary = clip(input.command || input.file_path || input.pattern || input.url || input.query || input.description || input.path || '', 160);
      a.pend.set(b.id, { name: b.name, summary, ts, key: durKey(b.name, input), inv });
      this.emit({ ts, kind: 'tool', agent: aid, tool: b.name, text: summary });
    }
  }
  toolResult(aid, id, text, ts, isErr, durable = !isErr) {
    this.pre.delete(id); this.unwait(w => w.tuid === id);   // allowed (the tool ran) or denied (the rejection is written as a result too)
    const a = this.agent(aid); this.stamp(a, ts); a.lastKind = 'result';
    const p = a.pend.get(id); if (!p) return;
    a.pend.delete(id); U.invDone(p.inv, ts - p.ts, isErr);
    if (durable && p.key && !(p.child && this.agent(p.child).bg)) durAdd(this.scope(), p.key, ts - p.ts, id);
    if (p.child) {
      const c = this.agent(p.child); this.stamp(c, ts);
      c.result = clip(text, 12000);
      if (!c.bg) { c.finished = true; c.end = ts; }
      this.emit({ ts, kind: 'result', from: p.child, to: aid, agent: p.child, text: clip(text, 1500) });
    } else {
      // started in the background, or moved there after a timeout: runs until its task-notification or a TaskStop
      const tid = (/^Command (?:running in background with ID: |was moved to the background \(ID: )(\w+)/.exec(text) || [])[1];
      if (tid && !isErr) a.shells.set(id, { s: p.summary, ts: p.ts, tid });
      const ms = Math.max(0, ts - p.ts); a.toolMs += ms;
      a.recent.push({ n: p.name, s: p.summary, ts: p.ts, ms, err: !!isErr });
      if (a.recent.length > 8) a.recent.shift();
    }
  }
  // tool_use id or task id from a task-notification / TaskStop. Kept as a set because files are read in any order,
  // so the notice can arrive before the shell it closes. An agent's own completion notice fires only once nothing it started is live.
  // shortcut: an agent resumed after that notice won't show new shells; track per-notice timestamps if that matters.
  shellDone(id) { this.ended.add(id); this.dirty = true; }
  meta(id, m) {
    if (!m) return; const a = this.agent(id);
    if (m.agentType) a.type = m.agentType;
    if (m.description) a.desc = m.description;
    if (m.requestShape === 'background') a.bg = true;
    if (m.finished) { a.finished = true; a.end = a.end || a.last || Date.now(); }
    this.dirty = true;
  }

  /* ---- "blocked on the human": set from hooks, cleared by anything that shows the agent moved on ---- */
  wait(key, w) { this.waits.set(key, { since: Date.now(), ...w, key: this.id + '|' + key }); this.dirty = true; }
  unwait(pred) { for (const [k, w] of this.waits) if (pred(w)) { this.waits.delete(k); this.dirty = true; } }
  nodeOf(who) {                               // hook agent_id -> our agent node id
    if (!who || who === 'main') return 'main';
    const st = this.subs.get(who); return st ? st.nodeId : this.agents.has('ag:' + who) ? 'ag:' + who : 'main';
  }
  // a dialog can stay open a long time with no activity at all, so pending waits keep a session "live" (up to 2h)
  scope() { return this.demo ? 'demo' : this.tp ? path.basename(path.dirname(this.tp)) : '*'; }   // where typical durations are looked up
  isLive() {
    const now = Date.now();
    return now - Math.max(this.lastHook, this.lastGrowth) < 10 * 60 * 1000 || [...this.waits.values()].some(w => now - w.since < 2 * 3600 * 1000);
  }

  snapshot() {
    const blockedBy = new Map();             // node id -> its waits, oldest first
    for (const w of [...this.waits.values()].sort((x, y) => x.since - y.since)) {
      const id = this.nodeOf(w.who); if (!blockedBy.has(id)) blockedBy.set(id, []); blockedBy.get(id).push(w);
    }
    const scope = this.scope();
    // Claude Code marks an agent finished each time it stops, even while its background children still run
    const kids = new Map(); for (const a of this.agents.values()) if (a.parent) { if (!kids.has(a.parent)) kids.set(a.parent, []); kids.get(a.parent).push(a); }
    const busyKids = (a, n = 0) => n < 20 ? (kids.get(a.id) || []).filter(c => !c.finished || busyKids(c, n + 1).length) : [];
    const depthOf = (a, n = 0) => { const p = a.parent && this.agents.get(a.parent); return p && n < 20 ? depthOf(p, n + 1) + 1 : 0; };
    const agents = [...this.agents.values()].map(a => {
      const tok = { in: 0, cr: 0, cw: 0, out: 0, think: 0 };
      for (const u of a.usage.values()) {
        tok.in += u.input_tokens || 0; tok.cr += u.cache_read_input_tokens || 0; tok.cw += u.cache_creation_input_tokens || 0;
        tok.out += u.output_tokens || 0; tok.think += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
      }
      const lu = a.lastUsage; tok.ctx = lu ? (lu.input_tokens || 0) + (lu.cache_read_input_tokens || 0) + (lu.cache_creation_input_tokens || 0) : 0;
      const pend = [...a.pend.values()], work = pend.filter(p => !p.child), spawn = pend.filter(p => p.child);
      let status = 'thinking', act = 'thinking…', actTool = '', actSince = a.last, est = null;
      const live = a.finished ? busyKids(a) : [];
      const shells = (this.rp || this.isLive()) && !this.ended.has(a.id.slice(3))   // a session that ended took its shells with it
        ? [...a.shells].filter(([k, x]) => !this.ended.has(k) && !this.ended.has(x.tid)).map(([, x]) => x) : [];
      const shTxt = shells.length ? shells.length + ' background shell' + (shells.length > 1 ? 's' : '') : '';
      if (a.finished && (live.length || shells.length)) { status = 'delegating'; actTool = live.length ? 'Agent' : 'Bash';
        act = 'waiting on ' + [...live.map(c => c.type), shTxt].filter(Boolean).join(', '); actSince = a.end; }
      else if (a.finished) { status = 'done'; act = 'finished'; }
      else if (work.length) { const p = work[work.length - 1]; status = 'running'; actTool = p.name; act = p.summary || p.name; actSince = p.ts; est = durEst(scope, p.key);
        if (work.length > 1) act += `  (+${work.length - 1} more)`; }
      else if (spawn.length) { status = 'delegating'; actTool = 'Agent'; act = 'waiting on ' + spawn.map(p => p.summary).join(', '); actSince = spawn[0].ts; est = durEst(scope, spawn[0].key); }
      else if (a.lastKind === 'end') { status = 'idle'; act = a.id === 'main' ? 'waiting for you' : 'idle'; }
      if (shells.length && status === 'idle' && a.id !== 'main') {
        status = 'delegating'; actTool = 'Bash'; act = 'waiting on ' + shTxt; actSince = Math.min(...shells.map(x => x.ts)); }
      else if (shells.length && !act.includes(shTxt)) act += ' · ' + shTxt + ' running';
      const bw = blockedBy.get(a.id);
      if (bw && !a.finished) { const w = bw.find(x => x.kind === 'approval') || bw[0];
        status = w.kind === 'approval' ? 'blocked' : 'asking'; actTool = w.tool; act = w.text; actSince = w.since; est = null; }
      const life = a.id !== 'main' && !a.bg ? durEst(scope, a.key || 'agent:' + a.type) : null;   // how long this agent type usually runs
      return { id: a.id, parent: a.parent, type: a.type, desc: a.desc, depth: depthOf(a), model: a.model, effort: a.effort, tok,
        calls: a.usage.size, tools: a.tools, toolMs: a.toolMs, thinkMs: a.thinkMs, first: a.first, last: a.last, end: live.length || shells.length ? null : a.end, shells,
        bg: a.bg, status, act, actTool, actSince, actEst: est ? est.ms : 0, actEstN: est ? est.n : 0, lifeEst: life ? life.ms : 0, lifeEstN: life ? life.n : 0,
        recent: a.recent, hist: a.hist, text: a.text, textTs: a.textTs, task: a.task, result: a.result };
    });
    return { id: this.id, title: this.title, cwd: this.cwd, branch: this.branch, version: this.version, permissionMode: this.permissionMode,
      mode: this.mode, first: this.first, last: this.last, cost: this.cost, demo: this.demo,
      replay: this.rp ? { ...this.rp } : null, file: this.demo ? null : this.tp,
      waiting: [...blockedBy].flatMap(([aid, ws]) => ws.map(w => ({ key: w.key, aid, kind: w.kind, tool: w.tool, text: w.text, questions: w.questions, since: w.since }))),
      live: this.rp ? !this.rp.done : this.isLive(), agents,
      usage: [...this.inv.values()], avail: Object.fromEntries(Object.entries(this.avail).map(([k, v]) => [k, [...v]])) };
  }
}

/* ------------------------------------------------------------------ */
/* Transcript reading (incremental)                                    */
/* ------------------------------------------------------------------ */
function readNew(st) {
  let size; try { const stt = fs.statSync(st.path); size = stt.size; st.mtime = stt.mtimeMs; } catch { return false; }
  if (size < st.off) st.off = 0;
  if (size === st.off) return false;
  const buf = Buffer.alloc(size - st.off);
  const fd = fs.openSync(st.path, 'r'); try { fs.readSync(fd, buf, 0, buf.length, st.off); } finally { fs.closeSync(fd); }
  const nl = buf.lastIndexOf(10); if (nl < 0) return false;       // ignore a half-written last line
  st.off += nl + 1;
  for (const l of buf.subarray(0, nl + 1).toString('utf8').split('\n')) {
    if (!l) continue; try { st.cb(JSON.parse(l)); } catch {}
  }
  return true;
}
const readMeta = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const blockText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text || '').join('\n') : '';

function feed(s, aid, m) {
  const ts = m.timestamp ? Date.parse(m.timestamp) : Date.now();
  if (m.cwd && !s.cwd) s.cwd = m.cwd;
  if (m.gitBranch) s.branch = m.gitBranch;
  if (m.version) s.version = m.version;
  switch (m.type) {
    case 'ai-title': s.title = m.aiTitle || s.title; break;
    case 'permission-mode': s.permissionMode = m.permissionMode || s.permissionMode; break;
    case 'mode': s.mode = m.mode || s.mode; break;
    case 'cost-state': s.cost = { usd: m.totalCostUSD, apiMs: m.totalAPIDuration, toolMs: m.totalToolDuration, totalMs: m.totalDuration,
                                  start: m.startTime, models: m.modelUsage }; break;
    case 'assistant': {
      if (m.isSidechain && aid === 'main') return;          // legacy in-file sidechains: not supported
      const msg = m.message || {};
      const a0 = s.agents.get(aid);
      if (aid !== 'main' && a0 && a0.finished && a0.end && ts > a0.end) { a0.finished = false; a0.end = null; s.dirty = true; }
      if (msg.usage) s.usage(aid, msg.id || m.requestId || m.uuid, msg.usage, msg.model, m.perTurnEffort || m.effort, ts);
      if (m.thinkingDurationMs) s.thinking(aid, m.thinkingDurationMs);
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'text' && b.text && b.text.trim()) s.text(aid, b.text, ts);
        else if (b.type === 'tool_use') s.toolUse(aid, b, ts);
      }
      if (msg.stop_reason === 'end_turn') s.endTurn(aid, ts);
      break;
    }
    case 'attachment':
    case 'user': {
      for (const [, id] of JSON.stringify(m.message || m.attachment || '').matchAll(/<(?:tool-use|task)-id>(\w+)<\/(?:tool-use|task)-id>/g)) s.shellDone(id);
      if (m.type === 'attachment') { const h = U.hookOf(m.attachment); if (h) U.invDone(U.invAdd(s.inv, h, aid, ts), m.attachment.durationMs, U.hookErr(m.attachment));
        U.availAdd(s.avail, U.availOf(m.attachment)); }
      if (m.type !== 'user' || (m.isSidechain && aid === 'main')) return;
      if (aid === 'main') for (const c of U.commandsIn(m)) U.invAdd(s.inv, c, 'user', ts);
      const c = m.message && m.message.content;
      if (typeof c === 'string') { if (aid === 'main' && !m.isMeta && !c.startsWith('<')) s.prompt(c, ts); }
      else if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'tool_result') s.toolResult(aid, b.tool_use_id, blockText(b.content), ts, b.is_error, durOk(m, b));
        else if (b.type === 'text' && aid === 'main' && !m.isMeta && b.text && !b.text.startsWith('<')) s.prompt(b.text, ts);
      }
      break;
    }
  }
  s.dirty = true;
}

function scan(s) {
  if (!s.tp) return;
  let grew = false;
  if (!s.main) { s.main = { path: s.tp, off: 0, cb: m => feed(s, 'main', m) }; learnProject(s.scope()); }
  grew = readNew(s.main) || grew;
  const dir = path.join(s.tp.replace(/\.jsonl$/, ''), 'subagents');
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    if (!/^agent-.+\.jsonl$/.test(n)) continue;
    const key = n.slice(6, -6), metaPath = path.join(dir, n.replace(/\.jsonl$/, '.meta.json'));
    let st = s.subs.get(key);
    if (!st) {
      const meta = readMeta(metaPath);
      let age = 0; try { age = Date.now() - fs.statSync(path.join(dir, n)).mtimeMs; } catch {}
      if (!meta && age < 4000) continue;                                 // wait briefly for the meta file
      const nodeId = meta && meta.toolUseId ? 'tu:' + meta.toolUseId : 'ag:' + key;
      st = { path: path.join(dir, n), off: 0, metaPath, nodeId, metaMt: 0, cb: m => feed(s, nodeId, m) };
      s.subs.set(key, st);
      s.agent(nodeId);
      if (!(meta && meta.toolUseId)) { s.agent(nodeId).parent = 'main'; s.agent(nodeId).type = (meta && meta.agentType) || 'agent'; }
    }
    grew = readNew(st) || grew;
    let mt = 0; try { mt = fs.statSync(st.metaPath).mtimeMs; } catch {}
    if (mt !== st.metaMt) { const meta = readMeta(st.metaPath); if (meta) { st.metaMt = mt; s.meta(st.nodeId, meta); } }
  }
  if (grew) {   // use the files' own modified time, so opening an old session doesn't make it look live
    s.lastGrowth = Math.max(s.lastGrowth, s.main.mtime || 0, ...[...s.subs.values()].map(x => x.mtime || 0));
    s.dirty = true;
  }
}

function getSession(id) { let s = sessions.get(id); if (!s) { s = new Session(id); sessions.set(id, s); } return s; }
const derivePath = (cwd, sid) => path.join(PROJECTS, String(cwd).replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');

function onHook(h) {
  if (!h.session_id) return;
  const s = getSession(h.session_id);
  if (!s.tp) s.tp = h.transcript_path || (h.cwd ? derivePath(h.cwd, h.session_id) : null);
  if (h.cwd && !s.cwd) s.cwd = h.cwd;
  if (h.permission_mode) s.permissionMode = h.permission_mode;
  s.lastHook = Date.now(); s.dirty = true;
  raw.push({ ts: Date.now(), ...h }); if (raw.length > 40) raw.shift();
  trackWaits(s, h);
  setImmediate(() => scan(s)); setTimeout(() => scan(s), 350); setTimeout(() => scan(s), 1200);
}

// Blocked-on-human detection. Nothing here waits or answers: the terminal dialog is untouched, we only show it.
const QTEXT = q => (q.questions || []).map(x => x.question).filter(Boolean).join(' · ');
// Tool calls that never wait on a permission dialog themselves (spawning stays "open" for the whole life of the sub-agent)
const NO_DIALOG = new Set(['Agent', 'Task', 'AskUserQuestion', 'SubagentHandback', 'SendMessage', 'TodoWrite']);
function trackWaits(s, h) {
  const who = h.agent_id || 'main', ev = h.hook_event_name, now = Date.now();
  if (ev === 'PreToolUse') {
    s.unwait(w => w.who === who && w.kind === 'approval');          // the agent moved on to its next tool call
    if (h.tool_use_id && !NO_DIALOG.has(h.tool_name)) s.pre.set(h.tool_use_id, { who, tuid: h.tool_use_id, tool: h.tool_name, input: h.tool_input || {}, ts: now });
    for (const [k, p] of s.pre) if (now - p.ts > 3600 * 1000) s.pre.delete(k);     // never let it grow forever
    if (h.tool_name === 'AskUserQuestion') {
      const inp = h.tool_input || {};
      s.wait('q:' + (h.tool_use_id || now), { who, kind: 'question', tool: 'AskUserQuestion', tuid: h.tool_use_id, text: clip(QTEXT(inp) || 'question', 300),
        questions: (inp.questions || []).slice(0, 4).map(q => ({ q: clip(q.question, 300), header: clip(q.header, 30), multi: !!q.multiSelect,
          options: (q.options || []).slice(0, 6).map(o => ({ label: clip(o.label, 80), description: clip(o.description, 160) })) })) });
    }
  } else if (ev === 'Notification') {
    const msg = String(h.message || ''), type = h.notification_type || (/permission/i.test(msg) ? 'permission_prompt' : '');
    if (type !== 'permission_prompt' && type !== 'elicitation_dialog') return;    // idle_prompt etc.: main already shows "waiting for you"
    // which call is waiting? The message is often just "Claude needs your permission", so: among the tool calls that are still open
    // (no result yet, agent not stopped), the newest one, preferring the tool the message names and the agent the hook names
    const named = (msg.match(/\buse (\w+)/) || [])[1];
    const cands = [...s.pre.values()].filter(x => !h.agent_id || x.who === h.agent_id).sort((a, b) => b.ts - a.ts);
    const p = cands.find(x => named && x.tool === named) || cands[0] || null, pw = p ? p.who : h.agent_id || 'main';
    if (!p && [...s.waits.values()].some(w => w.kind === 'question')) return;   // it's the open question's dialog, already shown
    const inp = (p && p.input) || {}, tool = (p && p.tool) || named || '';
    const detail = clip(inp.command || inp.file_path || inp.url || inp.pattern || inp.query || inp.description || '', 300);
    s.wait('a:' + ((p && p.tuid) || now), { who: pw, kind: 'approval', tool, tuid: p && p.tuid, text: detail || msg || 'needs your approval' });
    s.emit({ ts: now, kind: 'text', agent: s.nodeOf(pw), text: '⏸ needs approval: ' + tool + (detail ? ' · ' + detail : '') });
  } else if (ev === 'PostToolUse' || ev === 'PostToolUseFailure') {
    s.pre.delete(h.tool_use_id); s.unwait(w => w.tuid && w.tuid === h.tool_use_id);
  } else if (ev === 'SubagentStop') {
    for (const [k, p] of s.pre) if (p.who === who) s.pre.delete(k);
    s.unwait(w => w.who === who);
  } else if (ev === 'Stop') {
    for (const [k, p] of s.pre) if (p.who === 'main') s.pre.delete(k);
    s.unwait(w => w.who === 'main');
  } else if (ev === 'UserPromptSubmit') {
    s.pre.clear(); s.unwait(() => true);                                // you typed in the terminal, so no dialog is open
  }
}

/* ------------------------------------------------------------------ */
/* Playback: re-run a finished transcript step by step                 */
/* ------------------------------------------------------------------ */
const replays = new Map();   // session id -> runner

function loadEntries(file) {
  const out = []; let seq = 0;
  const addFile = (p, aid) => {
    let prev = 0, first = 0, last = 0;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; }
      const ts = m.timestamp ? Date.parse(m.timestamp) || prev : prev; if (ts) { prev = ts; first = first || ts; last = ts; }
      out.push({ ts, aid, m, seq: seq++ });
    }
    return { first, last };
  };
  addFile(file, 'main');
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    if (!/^agent-.+\.jsonl$/.test(n)) continue;
    const meta = readMeta(path.join(dir, n.replace(/\.jsonl$/, '.meta.json')));
    const aid = meta && meta.toolUseId ? 'tu:' + meta.toolUseId : 'ag:' + n.slice(6, -6);
    const { first, last } = addFile(path.join(dir, n), aid);
    if (meta) { out.push({ ts: first, aid, meta: { ...meta, finished: false }, seq: seq++ }); if (meta.finished) out.push({ ts: last, aid, fin: true, seq: seq++ }); }
  }
  out.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return out;
}

function purgeSession(id) { history.delete(id); }
function stopReplay(id) {
  const r = replays.get(id); if (!r) return;
  clearTimeout(r.timer); r.stopped = true; replays.delete(id); sessions.delete(id); purgeSession(id); lastSnap = '';
}
const isVisible = e => !e.meta && !e.fin && e.m && (e.m.type === 'assistant' || e.m.type === 'user');

function stepReplay(r) {
  if (r.stopped || r.paused) return;
  const s = r.s;
  for (;;) {
    const e = r.entries[r.i];
    if (!e) { s.rp.done = true; s.rp.paused = false; s.dirty = true; return; }
    r.i++;
    if (e.ts) r.clock = e.ts;
    if (e.meta) s.meta(e.aid, e.meta);
    else if (e.fin) s.meta(e.aid, { finished: true });
    else feed(s, e.aid, e.m);
    Object.assign(s.rp, { i: r.i, clock: r.clock, speed: r.speed, paused: false }); s.dirty = true;
    if (isVisible(e)) {
      const next = r.entries[r.i], gap = next && next.ts && e.ts ? Math.max(0, next.ts - e.ts) / r.speed : 0;
      const delay = Math.max(160 / r.speed, Math.min(1800 / Math.sqrt(r.speed), gap));   // long pauses shrink faster at higher speeds
      r.timer = setTimeout(() => stepReplay(r), delay); return;
    }
  }
}

function startReplay(file, speed) {
  const base = path.basename(file, '.jsonl'), id = 'replay-' + base.slice(0, 8);
  stopReplay(id);
  const entries = loadEntries(file);
  const s = new Session(id); sessions.set(id, s);
  s.tp = file; s.lastHook = Date.now();
  s.rp = { i: 0, n: entries.length, speed, paused: false, done: false, clock: entries.length ? entries[0].ts : Date.now(), file: base };
  const r = { s, entries, i: 0, speed, paused: false, clock: s.rp.clock, timer: null, stopped: false };
  replays.set(id, r);
  setImmediate(() => stepReplay(r));
  return id;
}
function controlReplay(id, action, speed) {
  const r = replays.get(id); if (!r) return false;
  if (action === 'pause') { r.paused = true; clearTimeout(r.timer); r.s.rp.paused = true; }
  else if (action === 'resume') { if (r.paused) { r.paused = false; r.s.rp.paused = false; stepReplay(r); } }
  else if (action === 'speed') { r.speed = Math.max(0.5, Math.min(256, Number(speed) || 4)); r.s.rp.speed = r.speed; }
  else if (action === 'restart') { startReplay(r.s.tp, r.speed); return true; }
  else if (action === 'stop') { stopReplay(id); return true; }
  r.s.dirty = true; return true;
}

/* periodic work: rescan live sessions, push changed snapshots */
setInterval(() => {
  for (const s of sessions.values()) if (!s.demo && !s.rp && s.isLive()) scan(s);
}, 1500);
let lastSnap = '';
setInterval(() => {
  const dirty = [...sessions.values()].some(s => s.dirty); if (!dirty) return;
  for (const s of sessions.values()) s.dirty = false;
  const snap = JSON.stringify([...sessions.values()].map(s => s.snapshot()).sort((a, b) => b.last - a.last));
  if (snap !== lastSnap) { lastSnap = snap; sendAll({ t: 'snap', sessions: JSON.parse(snap) }); }
}, 400);

/* ------------------------------------------------------------------ */
/* Demo: drives the very same Session model                            */
/* ------------------------------------------------------------------ */
function stopDemo() { for (const t of timers) clearTimeout(t); timers.clear(); }
function runDemo() {
  stopDemo();
  for (const [id, s] of sessions) if (s.demo) sessions.delete(id);
  const s = getSession('demo-' + Date.now().toString(36)); s.demo = true; s.lastHook = Date.now();
  Object.assign(s, { title: 'Demo: migrate auth to JWT', cwd: 'D:\\Work\\demo-app', branch: 'feature/jwt', version: '2.1.318', permissionMode: 'auto', mode: 'normal' });
  const OPUS = 'claude-opus-5-5', SON = 'claude-sonnet-5-5', HAI = 'claude-haiku-5-5';
  DUR.delete('demo');                 // made-up "past runs" so the demo shows estimates and progress bars
  for (const [k, list] of Object.entries({ 'Bash:npx eslint': [1300, 1500, 1200], 'Bash:npm test': [2200, 2600, 2400], Read: [700, 900, 800], Edit: [900, 1200, 1000],
    Write: [1000, 1100, 1300], Grep: [600, 800, 700], 'agent:planner': [3400, 3800], 'agent:coder': [6000, 7000, 6500], 'agent:docs-writer': [3000, 3600],
    'agent:linter': [1400, 1700], 'agent:tester': [4500, 5200] })) for (const ms of list) durAdd('demo', k, ms);
  let n = 0;
  const U = (aid, model, eff, inp, out, think = 0) => s.usage(aid, 'm' + (++n), { input_tokens: inp, cache_read_input_tokens: inp * 6, cache_creation_input_tokens: 800,
    output_tokens: out, output_tokens_details: { thinking_tokens: think } }, model, eff, Date.now());
  const T = (aid, id, name, input) => s.toolUse(aid, { id, name, input }, Date.now());
  const R = (aid, id, text) => s.toolResult(aid, id, text, Date.now());
  const spawn = (parent, id, type, desc, prompt) => T(parent, id, 'Agent', { subagent_type: type, description: desc, prompt });
  const done = id => { const a = s.agent('tu:' + id); a.finished = true; a.end = Date.now(); };
  const cost = usd => { s.cost = { usd, apiMs: 0, toolMs: 0, totalMs: 0, start: s.first, models: {} }; };
  const steps = [
    [0,    () => { s.prompt('Refactor the auth module to use JWT and add tests.', Date.now()); U('main', OPUS, 'medium', 900, 220, 90); cost(0.04); }],
    [900,  () => { T('main', 'r1', 'Read', { file_path: 'src/auth/index.ts' }); }],
    [1700, () => { R('main', 'r1', 'ok'); s.text('main', 'I will start by having the planner analyse the module, then delegate implementation and tests.', Date.now()); }],
    [2400, () => { spawn('main', 'p1', 'planner', 'Plan the JWT migration', 'Analyse src/auth and propose a step-by-step migration plan from sessions to JWT.'); U('tu:p1', SON, 'high', 1500, 300, 400); }],
    [3200, () => { T('tu:p1', 'p1a', 'Grep', { pattern: 'sessionStore' }); }],
    [4000, () => { R('tu:p1', 'p1a', '14 matches'); T('tu:p1', 'p1b', 'Read', { file_path: 'src/auth/session.ts' }); U('tu:p1', SON, 'high', 4200, 650, 900); }],
    [5200, () => { R('tu:p1', 'p1b', 'ok'); s.text('tu:p1', 'Plan: 1) add jwt util 2) swap middleware 3) migrate login/logout routes 4) write tests. 14 call sites need updating.', Date.now()); }],
    [6000, () => { R('main', 'p1', 'Plan: 1) add jwt util 2) swap middleware 3) migrate login/logout routes 4) write tests. 14 call sites need updating.'); U('main', OPUS, 'medium', 3200, 480, 150); cost(0.21); }],
    [6800, () => { spawn('main', 'c1', 'coder', 'Implement JWT migration', 'Implement steps 1-3 of the plan. Keep the public API unchanged.'); U('tu:c1', SON, 'medium', 2100, 380, 0); }],
    [7000, () => { spawn('main', 'd1', 'docs-writer', 'Write migration notes', 'Draft migration notes for the README about the new token flow.'); U('tu:d1', HAI, 'low', 900, 210, 0); }],
    [7800, () => { T('tu:c1', 'c1a', 'Edit', { file_path: 'src/auth/jwt.ts' }); T('tu:d1', 'd1a', 'Write', { file_path: 'docs/auth-migration.md' }); }],
    [8800, () => { R('tu:c1', 'c1a', 'ok'); spawn('tu:c1', 'l1', 'linter', 'Lint changed files', 'Run eslint on src/auth and report problems.'); U('tu:l1', HAI, 'low', 700, 90, 0); U('tu:c1', SON, 'medium', 5200, 900, 0); }],
    [9300, () => { T('tu:l1', 'l1a', 'Bash', { command: 'npx eslint src/auth --format compact' }); R('tu:d1', 'd1a', 'ok'); s.text('tu:d1', 'Wrote docs/auth-migration.md (62 lines).', Date.now()); }],
    [10300,() => { R('tu:l1', 'l1a', '0 problems'); s.text('tu:l1', 'eslint: 0 problems in 4 files.', Date.now()); R('tu:c1', 'l1', 'eslint: 0 problems in 4 files.'); done('l1'); R('main', 'd1', 'Wrote docs/auth-migration.md (62 lines).'); cost(0.37); }],
    [11200,() => { T('tu:c1', 'c1b', 'Edit', { file_path: 'src/auth/middleware.ts' }); U('tu:c1', SON, 'medium', 8100, 1250, 0); }],
    [12400,() => { R('tu:c1', 'c1b', 'ok'); T('tu:c1', 'c1c', 'Edit', { file_path: 'src/routes/login.ts' }); }],
    [13400,() => { R('tu:c1', 'c1c', 'ok'); s.text('tu:c1', 'Implemented JWT util, middleware swap and login/logout routes. 6 files changed.', Date.now()); R('main', 'c1', 'Implemented JWT util, middleware swap and login/logout routes. 6 files changed.'); U('main', OPUS, 'medium', 6800, 520, 200); cost(0.55); }],
    [14200,() => { spawn('main', 't1', 'tester', 'Write and run tests', 'Write and run tests for the new JWT auth flow. Report failures.'); U('tu:t1', SON, 'high', 2600, 700, 650); }],
    [15200,() => { T('tu:t1', 't1a', 'Write', { file_path: 'tests/auth.jwt.test.ts' }); }],
    [16200,() => { R('tu:t1', 't1a', 'ok'); T('tu:t1', 't1b', 'Bash', { command: 'npm test -- auth' }); U('tu:t1', SON, 'high', 6100, 940, 700);
                   s.subs.set('t1', { nodeId: 'tu:t1' }); s.wait('a:t1b', { who: 't1', kind: 'approval', tool: 'Bash', tuid: 't1b', text: 'npm test -- auth' }); }],
    [17000,() => { s.unwait(w => w.tuid === 't1b'); }],              // "approved in the terminal": the tests now run
    [18200,() => { R('tu:t1', 't1b', '11 passed, 1 failed'); s.text('tu:t1', '11 passed, 1 failed: token expiry boundary in refresh().', Date.now()); R('main', 't1', '11 passed, 1 failed: token expiry boundary in refresh().'); cost(0.71); }],
    [19000,() => { s.text('main', 'One test failed on the expiry boundary; sending the coder back to fix it.', Date.now()); spawn('main', 'c2', 'coder', 'Fix expiry boundary bug', 'Fix the off-by-one in refresh() found by the tester.'); U('tu:c2', SON, 'medium', 3000, 260, 0); }],
    [20000,() => { T('tu:c2', 'c2a', 'Edit', { file_path: 'src/auth/jwt.ts' }); }],
    [21200,() => { R('tu:c2', 'c2a', 'ok'); s.text('tu:c2', 'Fixed off-by-one in the expiry check.', Date.now()); R('main', 'c2', 'Fixed off-by-one in the expiry check.'); U('main', OPUS, 'medium', 7400, 610, 120); cost(0.83); }],
    [22200,() => { s.text('main', 'JWT migration complete: 7 files changed, 12/12 tests passing, docs added.', Date.now()); s.endTurn('main', Date.now()); }],
  ];
  for (const [ms, fn] of steps) { const t = setTimeout(() => { timers.delete(t); fn(); s.lastHook = Date.now(); s.dirty = true; }, ms); timers.add(t); }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
// After a restart (or Clear), pick up sessions that were active in the last 30 minutes instead of waiting for their next hook
function recoverRecent() {
  let n = 0;
  try { for (const d of fs.readdirSync(PROJECTS)) { const dir = path.join(PROJECTS, d);
    for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.jsonl')) continue; const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs < 30 * 60 * 1000) { const s = getSession(path.basename(f, '.jsonl')); s.tp = p; scan(s); n++; } } } } catch {}
  return n;
}
// title / first prompt / folder of a transcript on disk, for the session picker. Reads only the head and the tail, cached per file version.
const peekCache = new Map();
function peek(p, mtime, size) {
  const c = peekCache.get(p); if (c && c.mtime === mtime) return c.info;
  const info = { title: '', prompt: '', cwd: '' };
  const parse = (txt, fromTail) => { for (const l of txt.split('\n')) { if (!l.startsWith('{')) continue; let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.cwd && !info.cwd) info.cwd = m.cwd;
    if (m.type === 'ai-title' && m.aiTitle && (fromTail || !info.title)) info.title = m.aiTitle;      // the newest title wins
    if (!fromTail && !info.prompt && m.type === 'user' && !m.isMeta && !m.isSidechain) { const t = blockText(m.message && m.message.content).trim(); if (t && !t.startsWith('<')) info.prompt = t.slice(0, 200); } } };
  try {
    const fd = fs.openSync(p, 'r');
    try { const head = Buffer.alloc(Math.min(size, 65536)); fs.readSync(fd, head, 0, head.length, 0); parse(head.toString('utf8'), false);
      if (size > 65536) { const n = Math.min(size - 65536, 262144), tail = Buffer.alloc(n); fs.readSync(fd, tail, 0, n, size - n); parse(tail.toString('utf8'), true); } }
    finally { fs.closeSync(fd); }
  } catch {}
  peekCache.set(p, { mtime, info }); return info;
}
const DEFAULT_VIEW = 'mission';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const sendFile = (res, file) => fs.readFile(file, (e, b) => {
  if (e) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'text/plain'); res.setHeader('Cache-Control', 'no-cache'); res.end(b);
});
// A view is any views/<id>.html. Its <title> is the name; <meta name="mc-description"> and <meta name="mc-order"> are optional.
function listViews() {
  const dir = path.join(__dirname, 'views'); const out = [];
  try { for (const f of fs.readdirSync(dir)) {
    if (!/^[a-z0-9-]+\.html$/.test(f)) continue;
    const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 3000), meta = n => (head.match(new RegExp(`<meta name="${n}" content="([^"]*)"`)) || [])[1];
    out.push({ id: f.slice(0, -5), name: (head.match(/<title>([^<]*)<\/title>/) || [])[1] || f, description: meta('mc-description') || '', order: Number(meta('mc-order')) || 99 });
  } } catch {}
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}
const json = (res, o, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/hook') { try { onHook(JSON.parse(await readBody(req))); } catch {} return res.end('ok'); }
  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n'); res.write(`data: ${JSON.stringify({ t: 'hello' })}\n\n`);
    for (const list of history.values()) for (const ev of list) res.write(`data: ${JSON.stringify({ ...ev, hist: true })}\n\n`);   // hist: don't animate old events
    res.write(`data: ${JSON.stringify({ t: 'snap', sessions: [...sessions.values()].map(s => s.snapshot()).sort((a, b) => b.last - a.last) })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (url.pathname === '/api/sessions') {
    const out = [];
    try { for (const d of fs.readdirSync(PROJECTS)) { const dir = path.join(PROJECTS, d);
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) { const p = path.join(dir, f), st = fs.statSync(p); out.push({ path: p, mtime: st.mtimeMs, size: st.size, project: d, id: f.slice(0, -6) }); } } } catch {}
    out.sort((a, b) => b.mtime - a.mtime);
    return json(res, out.slice(0, Math.min(200, Number(url.searchParams.get('n')) || 60)).map(x => ({ ...x, ...peek(x.path, x.mtime, x.size) })));
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {          // load a past session
    try {
      const file = path.resolve(JSON.parse(await readBody(req)).file || '');
      if (!file.startsWith(PROJECTS + path.sep) || !file.endsWith('.jsonl') || !fs.existsSync(file)) return json(res, { error: 'not a Claude transcript' }, 400);
      const s = getSession(path.basename(file, '.jsonl')); s.tp = file; scan(s); return json(res, { ok: true, id: s.id });
    } catch (e) { return json(res, { error: String(e.message) }, 400); }
  }
  if (req.method === 'POST' && url.pathname === '/api/replay') {        // animated, step-by-step playback
    try {
      const b = JSON.parse(await readBody(req)), file = path.resolve(b.file || '');
      if (!file.startsWith(PROJECTS + path.sep) || !file.endsWith('.jsonl') || !fs.existsSync(file)) return json(res, { error: 'not a Claude transcript' }, 400);
      return json(res, { ok: true, id: startReplay(file, Math.max(0.5, Math.min(256, Number(b.speed) || 4))) });
    } catch (e) { return json(res, { error: String(e.message) }, 400); }
  }
  if (req.method === 'POST' && url.pathname === '/api/replay/control') {
    try { const b = JSON.parse(await readBody(req)); return json(res, { ok: controlReplay(b.id, b.action, b.speed) }); }
    catch (e) { return json(res, { error: String(e.message) }, 400); }
  }
  if (url.pathname === '/api/demo') { runDemo(); return res.end('ok'); }
  if (url.pathname === '/api/raw') return json(res, raw);
  if (url.pathname === '/api/usage') {      // cross-session totals: ?scope=<project folder>|*&days=N (0 = all time)
    try { return json(res, await U.crossUsage(PROJECTS, url.searchParams.get('scope') || '*', Number(url.searchParams.get('days') || 30))); }
    catch (e) { return json(res, { error: String(e.message || e) }, 500); }
  }
  if (url.pathname === '/api/durations') {   // debug: typical durations per scope, e.g. ?scope=D--Work-sdlc
    const m = DUR.get(url.searchParams.get('scope') || '*') || new Map();
    return json(res, Object.fromEntries([...m].sort((a, b) => b[1].length - a[1].length).map(([k, a]) => [k, { runs: a.length, median: durEst(url.searchParams.get('scope') || '*', k)?.ms }])));
  }
  if (url.pathname === '/api/clear') { stopDemo(); for (const id of [...replays.keys()]) stopReplay(id); sessions.clear(); history.clear(); lastSnap = ''; sendAll({ t: 'hello' }); recoverRecent(); return res.end('ok'); }

  /* views: every views/<id>.html is a selectable look & feel; they share /core.js and /core.css */
  if (url.pathname === '/api/views') return json(res, listViews());
  if (url.pathname === '/core.js' || url.pathname === '/core.css') return sendFile(res, path.join(__dirname, url.pathname.slice(1)));
  if (url.pathname === '/') return sendFile(res, path.join(__dirname, 'views', DEFAULT_VIEW + '.html'));
  const vm = url.pathname.match(/^\/v\/([a-z0-9-]+)$/);
  if (vm) return sendFile(res, path.join(__dirname, 'views', vm[1] + '.html'));
  res.statusCode = 404; res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Mission Control on http://localhost:${PORT}`);
  const n = recoverRecent(); if (n) console.log(`Recovered ${n} recently active session(s) from transcripts.`);
});
