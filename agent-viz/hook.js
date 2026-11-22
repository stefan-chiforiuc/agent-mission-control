// Forwards a Claude Code hook payload (stdin JSON) to Mission Control.
// Fails silently so it never blocks or slows your session.
const http = require('http');
let body = '';
process.stdin.on('data', d => body += d);
process.stdin.on('end', () => {
  const req = http.request({ host: '127.0.0.1', port: Number(process.env.AGENT_VIZ_PORT || 7777),
    path: '/hook', method: 'POST', timeout: 500 }, r => { r.resume(); r.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
});
