// Smoke test for static mode: runs static.js (and through it server.js) in a fake browser over a fake picked folder.
// Usage: node agent-viz/static.test.js   (builds _site first)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const site = path.join(__dirname, '..', '_site');
execFileSync(process.execPath, [path.join(__dirname, 'build-static.js'), site]);
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, getElementById() { return null; } };
globalThis.fetch = async f => new Response(fs.readFileSync(path.join(site, f)));   // the page's own files
eval(fs.readFileSync(path.join(site, 'static.js'), 'utf8'));

const line = o => JSON.stringify(o) + '\n', ts = i => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const main = line({ type: 'user', timestamp: ts(0), cwd: '/w/demo', message: { role: 'user', content: 'Add tests please' } })
  + line({ type: 'assistant', timestamp: ts(1), message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'tester', description: 'run tests', prompt: 'go' } }] } })
  + line({ type: 'user', timestamp: ts(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all green' }] } });
const sub = line({ type: 'assistant', timestamp: ts(2), message: { id: 'm2', model: 'claude-haiku-5-5', usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: 'text', text: 'ok' }] } });
const file = (rel, body) => ({ name: rel.split('/').pop(), size: body.length, lastModified: Date.parse(ts(9)), webkitRelativePath: rel, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
const picked = [file('projects/w-demo/s1.jsonl', main), file('projects/w-demo/s1/subagents/agent-a1.jsonl', sub),
  file('projects/w-demo/s1/subagents/agent-a1.meta.json', JSON.stringify({ toolUseId: 't1', agentType: 'tester' })), file('projects/w-demo/notes.txt', 'x')];

(async () => {
  assert.strictEqual(await window.MC_STATIC.load(picked, () => {}), 1);
  const views = await (await fetch('/api/views')).json();
  assert.deepStrictEqual(views.map(v => v.id).sort(), ['classic', 'mission']);
  const list = await (await fetch('/api/sessions?n=10')).json();
  assert.strictEqual(list.length, 1); assert.strictEqual(list[0].prompt, 'Add tests please');
  const opened = await (await fetch('/api/open', { method: 'POST', body: JSON.stringify({ file: list[0].path }) })).json();
  assert.strictEqual(opened.id, 's1');
  const bad = await fetch('/api/open', { method: 'POST', body: JSON.stringify({ file: '/etc/passwd' }) });
  assert.strictEqual(bad.status, 400);
  const snap = await new Promise(r => { const es = new EventSource('/stream'); es.onmessage = m => { const d = JSON.parse(m.data); if (d.t === 'snap') r(d); }; });
  const s = snap.sessions.find(x => x.id === 's1');
  assert.ok(s.agents.some(a => a.type === 'tester'), 'sub-agent from subagents/ is in the tree');
  const rp = await (await fetch('/api/replay', { method: 'POST', body: JSON.stringify({ file: list[0].path, speed: 64 }) })).json();
  assert.ok(rp.ok && rp.id);
  const u = await (await fetch('/api/usage?scope=*&days=0')).json();
  assert.strictEqual(u.sessions, 1);
  console.log('static mode ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
