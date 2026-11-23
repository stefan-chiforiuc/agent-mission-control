// node usage.test.js
const assert = require('assert');
const U = require('./usage');
assert.deepStrictEqual(U.classify('Bash', {}), { cat: 'tool', name: 'Bash', src: '' });
assert.deepStrictEqual(U.classify('mcp__claude_ai_Claude_Docs__batch'), { cat: 'mcp', name: 'claude.ai Claude Docs · batch', src: 'claude.ai Claude Docs' });
assert.deepStrictEqual(U.classify('mcp__plugin_ponytail_srv__go'), { cat: 'mcp', name: 'srv · go', src: 'plugin ponytail · srv' });
assert.deepStrictEqual(U.classify('Skill', { skill: 'superpowers:brainstorming' }), { cat: 'skill', name: 'superpowers:brainstorming', src: 'superpowers' });
assert.deepStrictEqual(U.classify('Agent', { subagent_type: 'Explore' }), { cat: 'agent', name: 'Explore', src: '' });
assert.deepStrictEqual(U.commandsIn({ type: 'user', message: { content: '<command-name>/ponytail:ponytail</command-name>' } }), [{ cat: 'command', name: '/ponytail:ponytail', src: 'ponytail' }]);
assert.deepStrictEqual(U.commandsIn({ type: 'api-request-blob', message: { content: '<command-name>/x</command-name>' } }), []);
const lines = [
  { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] } },
  { type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] } },
  { type: 'attachment', timestamp: '2026-01-01T00:00:03Z', attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', durationMs: 50, exitCode: 0 } },
  { type: 'attachment', attachment: { type: 'skill_listing', content: '- dataviz: charts\n- ponytail:ponytail: lazy' } },
].map(x => JSON.stringify(x)).join('\n');
const r = U.scanText(lines, 'main'), read = r.inv.get('tool|Read'), hook = r.inv.get('hook|UserPromptSubmit');
assert.strictEqual(read.calls, 1); assert.strictEqual(read.errs, 1); assert.strictEqual(read.ms, 2000);
assert.strictEqual(hook.ms, 50); assert.strictEqual(hook.errs, 0);
assert.deepStrictEqual([...r.avail.skill], ['dataviz', 'ponytail:ponytail']);
console.log('usage ok');
