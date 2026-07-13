#!/usr/bin/env node
// Demo Recording — Step 3 capture: review a cut and dictate time-stamped notes.
//
//   node packages/desktop/demo/reviewNotes.js <recording-dir> [--cut rough-cut.v2.mp4] [--port 7788]
//
// Serves a tiny local page (annotate.html) that plays the cut. You pause at a
// moment, press N, and dictate — the page captures the exact playhead time and
// auto-saves to <recording-dir>/notes.json. Localhost (a secure context) so
// in-browser live dictation works; macOS dictation (fn fn) works regardless.
//
// Notes are timed against the chosen cut's OUTPUT timeline; I correlate them to
// the manifest event spine when writing the manuscript (Step 3).

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

function parseArgs(argv) {
  const a = { dir: null, cut: null, port: 7788 };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--cut') a.cut = argv[++i];
    else if (x === '--port') a.port = Number(argv[++i]);
    else if (!x.startsWith('--')) a.dir = x;
  }
  return a;
}

const args = parseArgs(process.argv);
if (!args.dir) { console.error('Usage: node reviewNotes.js <recording-dir> [--cut rough-cut.v2.mp4] [--port 7788]'); process.exit(1); }
const DIR = path.resolve(args.dir);
if (!fs.existsSync(DIR)) { console.error(`No such dir: ${DIR}`); process.exit(1); }

// Default to the highest-version rough cut.
const cut = args.cut || fs.readdirSync(DIR)
  .filter((f) => /^rough-cut\.v\d+\.mp4$/.test(f))
  .sort((a, b) => (+b.match(/\d+/)[0]) - (+a.match(/\d+/)[0]))[0];
if (!cut || !fs.existsSync(path.join(DIR, cut))) { console.error(`No rough-cut mp4 found in ${DIR} (run roughCut.js first, or pass --cut).`); process.exit(1); }

const videoPath = path.join(DIR, cut);
const notesPath = path.join(DIR, 'notes.json');
const pagePath = path.join(__dirname, 'annotate.html');

function serveVideo(req, res) {
  const stat = fs.statSync(videoPath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    return fs.createReadStream(videoPath).pipe(res);
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4',
  });
  fs.createReadStream(videoPath, { start, end }).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(pagePath).pipe(res);
  } else if (url === '/video') {
    serveVideo(req, res);
  } else if (url === '/meta') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cut, recording: path.basename(DIR) }));
  } else if (url === '/notes' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : JSON.stringify({ notes: [] }));
  } else if (url === '/notes' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try { JSON.parse(body); fs.writeFileSync(notesPath, body); res.writeHead(200); res.end('ok'); }
      catch { res.writeHead(400); res.end('bad json'); }
    });
  } else { res.writeHead(404); res.end('not found'); }
});

server.listen(args.port, () => {
  const url = `http://localhost:${args.port}`;
  console.log(`Review "${cut}" → notes saved to ${path.relative(process.cwd(), notesPath)}`);
  console.log(`Open: ${url}`);
  execFile('open', [url], () => {});
});
