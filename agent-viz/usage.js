// Usage inventory: which tools, MCP servers, skills, slash commands, sub-agents and hooks were used, by whom, how often.
// Shared by the live session model (server.js) and the cross-session scan (/api/usage).
const fs = require('fs');
const path = require('path');

const pluginOf = s => { const i = s.indexOf(':'); return i > 0 ? s.slice(0, i) : ''; };
// a tool_use -> { cat: tool | mcp | skill | agent, name, src } (src = MCP server, or the plugin a skill / agent comes from)
function classify(name, input) {
  input = input || {};
  if (name === 'Skill') { const s = String(input.skill || input.command || '?').replace(/^\//, ''); return { cat: 'skill', name: s, src: pluginOf(s) }; }
  if (name === 'Agent' || name === 'Task') { const t = String(input.subagent_type || 'general-purpose'); return { cat: 'agent', name: t, src: pluginOf(t) }; }
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) {
    // shortcut: a plugin name containing "_" is split wrong; read the plugin's .mcp.json if that shows up
    const p = /^plugin_([^_]+)_(.+)$/.exec(m[1]);
    const srv = p ? p[2] : m[1].replace(/^claude_ai_/, 'claude.ai ').replace(/_/g, ' ');
    return { cat: 'mcp', name: srv + ' · ' + m[2], src: p ? 'plugin ' + p[1] + ' · ' + srv : srv };
  }
  return { cat: 'tool', name, src: '' };
}
// "/ponytail:ponytail" typed in the terminal; origin says when a plugin supplied it
const commandOf = (n, origin) => ({ cat: 'command', name: n, src: pluginOf(n.replace(/^\//, '')) || (origin && origin.kind === 'plugin' && origin.name) || '' });
// hook runs Claude Code wrote down (not every event leaves a record)
const HOOK_REC = /^hook_(success|.*error.*)$/;
const hookOf = a => a && HOOK_REC.test(a.type || '') && a.hookName ? { cat: 'hook', name: a.hookName, src: a.hookEvent && a.hookEvent !== a.hookName ? a.hookEvent : '' } : null;
const hookErr = a => a.type !== 'hook_success' || !!a.exitCode;
// slash commands in a user message (string or text blocks)
function commandsIn(m) {
  if (!m || m.type !== 'user' || !m.message) return [];
  const c = m.message.content, t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.type === 'text' ? b.text || '' : '').join('\n') : '';
  return t.includes('<command-name>') ? [...t.matchAll(/<command-name>\s*([^<\s]+)\s*<\/command-name>/g)].map(x => commandOf(x[1], m.origin)) : [];
}

// what the session had loaded: { skill: [...], agent: [...], tool: [...], mcp: [...] } as [cat, names] pairs
function availOf(a) {
  if (!a) return null;
  if (a.type === 'skill_listing' && typeof a.content === 'string') return ['skill', [...a.content.matchAll(/^- (\S+?):(?:\s|$)/gm)].map(x => x[1].trim())];
  if (a.type === 'agent_listing_delta' && Array.isArray(a.addedTypes)) return ['agent', a.addedTypes];
  if (a.type === 'deferred_tools_delta' && Array.isArray(a.addedNames)) return ['tools', a.addedNames];
  return null;
}
function availAdd(avail, pair) {
  if (!pair) return;
  const [kind, names] = pair;
  for (const n of names) { const c = kind === 'tools' ? classify(n) : { cat: kind, name: n };
    (avail[c.cat] || (avail[c.cat] = new Set())).add(c.name); }
}

function invAdd(inv, c, who, ts) {
  const k = c.cat + '|' + c.name; let r = inv.get(k);
  if (!r) inv.set(k, r = { cat: c.cat, name: c.name, src: c.src || '', calls: 0, errs: 0, ms: 0, timed: 0, by: {}, first: ts, last: ts });
  r.calls++; r.by[who] = (r.by[who] || 0) + 1;
  if (ts && (!r.first || ts < r.first)) r.first = ts; if (ts > r.last) r.last = ts;
  return r;
}
function invDone(r, ms, err) { if (err) r.errs++; if (ms >= 0 && ms < 6 * 3600e3) { r.ms += ms; r.timed++; } }

/* ---------- cross-session: every transcript in a project (or all projects) ---------- */
const fileCache = new Map();   // file -> { mt, size, inv, avail }
function scanText(txt, who) {
  const inv = new Map(), avail = {}, open = new Map();
  for (const l of txt.split('\n')) {
    if (!l.includes('"tool_use"') && !l.includes('"tool_result"') && !l.includes('<command-name>') && !l.includes('"attachment"')) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(m.timestamp) || 0;
    if (m.type === 'attachment') {
      const h = hookOf(m.attachment); if (h) invDone(invAdd(inv, h, who, ts), m.attachment.durationMs, hookErr(m.attachment));
      availAdd(avail, availOf(m.attachment)); continue;
    }
    if (who === 'main' && !m.isSidechain) for (const c of commandsIn(m)) invAdd(inv, c, 'user', ts);
    const c = m.message && m.message.content; if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_use' && m.type === 'assistant') open.set(b.id, { r: invAdd(inv, classify(b.name, b.input), who, ts), ts });
      else if (b.type === 'tool_result') { const o = open.get(b.tool_use_id); if (o) { open.delete(b.tool_use_id); invDone(o.r, ts - o.ts, !!b.is_error); } }
    }
  }
  return { inv, avail };
}
// main transcripts and their sub-agent files, newer than `since`
async function listFiles(dirs, since) {
  const out = [];
  for (const dir of dirs) {
    let names; try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n), sid = n.slice(0, -6);
      try { const st = await fs.promises.stat(f); if (st.mtimeMs >= since) out.push({ f, sid, who: 'main', st }); } catch { continue; }
      const sd = path.join(dir, sid, 'subagents');
      let subs = []; try { subs = await fs.promises.readdir(sd); } catch {}
      for (const s of subs) {
        if (!/^agent-.+\.jsonl$/.test(s)) continue;
        const sf = path.join(sd, s); let meta = null; try { meta = JSON.parse(fs.readFileSync(sf.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
        try { const st = await fs.promises.stat(sf); if (st.mtimeMs >= since) out.push({ f: sf, sid, who: (meta && meta.agentType) || 'agent', st }); } catch {}
      }
    }
  }
  return out;
}
async function crossUsage(projectsDir, scope, days) {
  const dirs = [];
  if (scope && scope !== '*') { if (/^[^\\/.][^\\/]*$/.test(scope)) dirs.push(path.join(projectsDir, scope)); }
  else try { for (const d of await fs.promises.readdir(projectsDir)) dirs.push(path.join(projectsDir, d)); } catch {}
  const since = days > 0 ? Date.now() - days * 86400e3 : 0;
  const files = await listFiles(dirs, since), rows = new Map(), avail = {}, sessions = new Set(), projects = new Set();
  for (const x of files) {
    if (x.st.size > 40e6) continue;
    let c = fileCache.get(x.f);
    if (!c || c.mt !== x.st.mtimeMs || c.size !== x.st.size) {
      let txt; try { txt = await fs.promises.readFile(x.f, 'utf8'); } catch { continue; }
      c = { mt: x.st.mtimeMs, size: x.st.size, ...scanText(txt, x.who) }; fileCache.set(x.f, c);
      await new Promise(r => setImmediate(r));          // stay responsive while scanning
    }
    if (x.who === 'main') { sessions.add(x.sid); projects.add(path.basename(path.dirname(x.f))); }
    for (const [k, v] of Object.entries(c.avail)) { const s = avail[k] || (avail[k] = new Set()); for (const n of v) s.add(n); }
    for (const [k, r] of c.inv) {
      let t = rows.get(k);
      if (!t) rows.set(k, t = { ...r, calls: 0, errs: 0, ms: 0, timed: 0, by: {}, sessions: new Set(), first: r.first, last: r.last });
      t.calls += r.calls; t.errs += r.errs; t.ms += r.ms; t.timed += r.timed; t.sessions.add(x.sid);
      for (const [w, n] of Object.entries(r.by)) t.by[w] = (t.by[w] || 0) + n;
      if (r.first && (!t.first || r.first < t.first)) t.first = r.first; if (r.last > t.last) t.last = r.last;
    }
  }
  return { scope: scope || '*', days, sessions: sessions.size, projects: projects.size, files: files.length,
    rows: [...rows.values()].map(r => ({ ...r, sessions: r.sessions.size })), avail: Object.fromEntries(Object.entries(avail).map(([k, v]) => [k, [...v]])) };
}

module.exports = { classify, commandsIn, hookOf, hookErr, availOf, availAdd, invAdd, invDone, scanText, crossUsage };
