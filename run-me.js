#!/usr/bin/env node
// Agent Mission Control launcher (zero dependencies).
//
//   node run-me.js                       start the dashboard server (http://localhost:7777)
//   node run-me.js start [--port N] [--open]
//   node run-me.js install <project>     add the hooks to <project>/.claude/settings.local.json
//   node run-me.js install <project> --shared    ...to settings.json instead (committed to git!)
//   node run-me.js install <project> --start     install, then start the server
//   node run-me.js uninstall <project> [--shared]
//
// install creates the settings file if missing, otherwise merges into it:
// your other settings and hooks are kept, a .bak copy is written first, and
// running install twice never duplicates entries.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const HOOK = path.join(ROOT, 'agent-viz', 'hook.js');
const SERVER = path.join(ROOT, 'agent-viz', 'server.js');
const MARKER = 'agent-viz/hook.js'; // identifies entries we own (slashes normalized)

// event -> matcher (null = no matcher field)
const EVENTS = {
  UserPromptSubmit: null,
  PreToolUse: '*',
  PostToolUse: 'Task|Agent',
  SubagentStop: null,
  Stop: null,
};

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
const cmd = ['start', 'install', 'uninstall'].includes(positional[0]) ? positional.shift() : 'start';

const die = msg => { console.error('error: ' + msg); process.exit(1); };
const isOurs = h => typeof h.command === 'string' && h.command.replace(/\\/g, '/').includes(MARKER);

function hookCommand() {
  return `node "${HOOK.replace(/\\/g, '/')}"`;
}

function settingsPath() {
  const dir = positional[0];
  if (!dir) die(`usage: node run-me.js ${cmd} <project-folder> [--shared]`);
  const proj = path.resolve(dir);
  if (!fs.existsSync(proj) || !fs.statSync(proj).isDirectory()) die(`not a folder: ${proj}`);
  return path.join(proj, '.claude', flag('shared') ? 'settings.json' : 'settings.local.json');
}

function load(file) {
  if (!fs.existsSync(file)) return { settings: {}, existed: false };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { settings: {}, existed: true, raw };
  try { return { settings: JSON.parse(raw), existed: true, raw }; }
  catch (e) { die(`${file} is not valid JSON (${e.message}). Fix it first; nothing was changed.`); }
}

// Remove our entries, dropping any group/event left empty.
function strip(hooks) {
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) }))
      .filter(g => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
}

function write(file, settings, existed, raw) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existed && raw && !fs.existsSync(file + '.bak')) fs.writeFileSync(file + '.bak', raw); // keep the first (original) backup
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function install() {
  const file = settingsPath();
  const { settings, existed, raw } = load(file);
  if (settings.hooks && typeof settings.hooks !== 'object') die('"hooks" in that file is not an object.');
  settings.hooks = settings.hooks || {};
  strip(settings.hooks); // makes re-install idempotent and refreshes a moved path
  for (const [ev, matcher] of Object.entries(EVENTS)) {
    const group = { hooks: [{ type: 'command', command: hookCommand() }] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
  }
  write(file, settings, existed, raw);
  console.log(`${existed ? 'Merged hooks into' : 'Created'} ${file}`);
  if (existed) console.log(`Original backed up at ${file}.bak (kept from the first install)`);
  if (flag('shared')) console.log('Note: settings.json is usually committed; the hook path above is specific to this machine.');
  console.log('Restart any running Claude Code session in that project so it picks up the hooks.');
}

function uninstall() {
  const file = settingsPath();
  const { settings, existed, raw } = load(file);
  if (!existed || !settings.hooks) return console.log('Nothing to remove.');
  strip(settings.hooks);
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  write(file, settings, existed, raw);
  console.log(`Removed Mission Control hooks from ${file}`);
}

function start() {
  const port = String(opt('port') || process.env.PORT || 7777);
  const child = spawn(process.execPath, [SERVER, port], { stdio: 'inherit', env: { ...process.env, PORT: port } });
  child.on('exit', code => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill());
  if (port !== '7777') console.log(`Hooks default to port 7777; set AGENT_VIZ_PORT=${port} for Claude Code to match.`);
  if (flag('open')) {
    const url = `http://localhost:${port}`;
    setTimeout(() => {
      const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(c, a, { stdio: 'ignore', detached: true }).unref();
    }, 600);
  }
}

if (cmd === 'install') { install(); if (flag('start')) start(); }
else if (cmd === 'uninstall') uninstall();
else start();
