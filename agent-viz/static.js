// Static mode (GitHub Pages): there is no Node server, so server.js itself runs here in the browser,
// over a folder the visitor picks. Files are read by this page only; nothing is uploaded anywhere.
// Loaded before core.js; build-static.js puts it into every page.
(() => {
  window.MC_STATIC = {};        // truthy flag for core.js; .load is for tests
  const HOME = '/home', PROJECTS = HOME + '/.claude/projects', APP = '/app';
  const files = new Map(), mtimes = new Map();      // virtual path -> bytes / modified time
  const dec = new TextDecoder(), enc = new TextEncoder();

  /* ---------- the few Node APIs server.js and usage.js use ---------- */
  class Buf extends Uint8Array { toString() { return dec.decode(this); } }
  const norm = p => { const o = []; for (const s of String(p).split(/[\\/]/)) { if (!s || s === '.') continue; if (s === '..') o.pop(); else o.push(s); } return '/' + o.join('/'); };
  const path = { sep: '/', join: (...a) => norm(a.join('/')), resolve: (...a) => norm(a.join('/')),   // every path here is absolute
    dirname: p => norm(p + '/..'), basename: (p, ext) => { const b = norm(p).split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
    extname: p => (/\.[^./]*$/.exec(p) || [''])[0] };
  const enoent = p => Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
  const get = p => { const d = files.get(norm(p)); if (!d) throw enoent(p); return d; };
  const readdirSync = d => { d = norm(d) + '/'; const s = new Set(); for (const k of files.keys()) if (k.startsWith(d)) s.add(k.slice(d.length).split('/')[0]); if (!s.size) throw enoent(d); return [...s]; };
  const statSync = p => ({ size: get(p).length, mtimeMs: mtimes.get(norm(p)) || 0 });
  const fds = new Map(); let nfd = 3;
  const fs = { readdirSync, statSync, existsSync: p => files.has(norm(p)),
    readFileSync: (p, e) => e ? dec.decode(get(p)) : get(p),
    openSync: p => { fds.set(nfd, get(p)); return nfd++; }, closeSync: fd => fds.delete(fd),
    readSync: (fd, buf, off, len, pos) => { const d = fds.get(fd).subarray(pos, pos + len); buf.set(d, off); return d.length; },
    readFile: (p, cb) => { let d; try { d = get(p); } catch (e) { return cb(e); } cb(null, d); },
    promises: { readdir: async d => readdirSync(d), stat: async p => statSync(p), readFile: async (p, e) => fs.readFileSync(p, e) } };
  let handler = null;
  const mods = { fs, path, os: { homedir: () => HOME }, http: { createServer: h => ({ listen: (port, host, cb) => { handler = h; if (cb) cb(); } }) } };
  const run = (src, name) => {
    const module = { exports: {} }, require = n => { const m = mods[n.replace(/^\.\//, '')]; if (!m) throw new Error('static mode has no module ' + n); return m; };
    new Function('require', 'module', 'exports', '__dirname', 'process', 'Buffer', 'setImmediate', src + '\n//# sourceURL=' + name)(
      require, module, module.exports, APP, { argv: [], env: {} }, { alloc: n => new Buf(n) }, f => setTimeout(f, 0));
    return module.exports;
  };

  /* ---------- boot: the same server code, its HTTP routes answered in-page ---------- */
  const realFetch = window.fetch.bind(window);
  const text = async f => { const r = await realFetch(f); if (!r.ok) throw new Error(f + ': HTTP ' + r.status); return r.text(); };
  const ready = (async () => {
    for (const f of await (await realFetch('views.json')).json()) files.set(APP + '/views/' + f, enc.encode(await text(f)));   // for /api/views
    mods.usage = run(await text('usage.js'), 'usage.js');
    run(await text('server.js'), 'server.js');
  })();
  ready.catch(e => console.error('[static] could not start', e));

  window.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!u.startsWith('/api/')) return realFetch(input, init);
    await ready;
    return new Promise(resolve => {
      const body = init.body || '', hdr = {};
      const req = { method: init.method || 'GET', url: u, on: (ev, cb) => { if (ev === 'data' && body) setTimeout(() => cb(body)); if (ev === 'end') setTimeout(cb); } };
      const res = { statusCode: 200, setHeader: (k, v) => { hdr[k] = v; }, writeHead() {}, write() {},
        end: b => resolve(new Response(b == null ? '' : b, { status: res.statusCode, headers: hdr })) };
      handler(req, res);
    });
  };
  window.EventSource = class {
    constructor(u) {
      ready.then(() => {
        const res = { writeHead() {}, write: c => { for (const part of String(c).split('\n\n')) { const m = /^data: ([\s\S]*)/.exec(part); if (m && this.onmessage) this.onmessage({ data: m[1] }); } } };
        if (this.onopen) this.onopen();
        const conn = document.getElementById('mc-conn'); if (conn) conn.textContent = 'LOCAL FILES';
        handler({ method: 'GET', url: u, on() {} }, res);
      }, () => this.onerror && this.onerror());
    }
    close() {}
  };

  /* ---------- the folder picker ---------- */
  // shortcut: reads every picked transcript into memory up front (server.js reads synchronously); make reads lazy if people pick multi-GB folders
  async function load(list, say) {
    list = list.filter(f => /\.jsonl$|\.meta\.json$/.test(f.name) && f.size < 40e6);
    const parts = f => f.webkitRelativePath.split('/');
    const oneProject = list.some(f => parts(f).length === 2 && f.name.endsWith('.jsonl'));   // picked a project folder, not projects/
    let i = 0;
    for (const f of list) {
      const p = parts(f), rest = p[1] === 'projects' ? p.slice(2) : oneProject ? p : p.slice(1);   // picked .claude / one project / projects
      const vp = norm(PROJECTS + '/' + rest.join('/'));
      files.set(vp, new Uint8Array(await f.arrayBuffer())); mtimes.set(vp, f.lastModified);
      if (++i % 50 === 0) say(`reading ${i}/${list.length}…`);
    }
    return list.filter(f => f.name.endsWith('.jsonl') && !f.webkitRelativePath.includes('/subagents/')).length;   // sessions, not sub-agents
  }
  window.MC_STATIC.load = load;
  document.addEventListener('DOMContentLoaded', () => {
    const demo = document.getElementById('mc-demo'); if (!demo) return;
    const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true });
    inp.webkitdirectory = true;
    const btn = Object.assign(document.createElement('button'), { textContent: '📂 Open sessions folder',
      title: 'Pick ~/.claude/projects (or one project folder in it). Read in this browser only; nothing is uploaded.' });
    const hint = Object.assign(document.createElement('span'), { className: 'pill',
      textContent: 'Static preview: open your ~/.claude/projects folder (stays in your browser) or press ▶ Demo' });
    demo.before(hint, btn, inp);
    btn.onclick = () => inp.click();
    inp.onchange = async () => {
      const say = t => { hint.textContent = t; };
      say('reading…');
      try {
        const n = await load([...inp.files], say);
        say(n ? `${n} sessions loaded · pick one in the session list` : 'no Claude transcripts (.jsonl) in that folder');
        if (n && window.MC && MC.reloadPast) { MC.reloadPast(); const pop = document.getElementById('mc-spop'); if (pop && pop.hidden) document.getElementById('mc-sbtn').click(); }
      } catch (e) { say('could not read the folder: ' + e.message); }
      inp.value = '';
    };
  });
})();
