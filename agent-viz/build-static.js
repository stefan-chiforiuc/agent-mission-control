// Builds the GitHub Pages version into <out> (default ../_site): the same views, with server.js running
// in the browser over a folder the visitor picks (see static.js). Usage: node agent-viz/build-static.js [out]
const fs = require('fs');
const path = require('path');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '_site'));
fs.mkdirSync(out, { recursive: true });
for (const f of ['core.js', 'core.css', 'server.js', 'usage.js', 'static.js']) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
const views = fs.readdirSync(path.join(__dirname, 'views')).filter(f => /^[a-z0-9-]+\.html$/.test(f));
for (const f of views) {
  const html = fs.readFileSync(path.join(__dirname, 'views', f), 'utf8');
  const page = html.replace('href="/core.css"', 'href="core.css"').replace('<script src="/core.js"></script>', '<script src="static.js"></script><script src="core.js"></script>');
  if (!page.includes('src="static.js"') || !page.includes('href="core.css"')) throw new Error(`${f}: needs <link rel="stylesheet" href="/core.css"> and <script src="/core.js"></script>`);
  fs.writeFileSync(path.join(out, f), page);
}
fs.copyFileSync(path.join(out, 'mission.html'), path.join(out, 'index.html'));   // the default view, as in server.js
fs.writeFileSync(path.join(out, 'views.json'), JSON.stringify(views));
console.log(`static site: ${out} (${views.length} views)`);
