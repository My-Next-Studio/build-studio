#!/usr/bin/env node
// Demo Recording — Step 1.5: transcribe live narration into edit directives + notes.
//
//   node packages/desktop/demo/transcribeDirectives.js <recording-dir> [options]
//
// When the demo was recorded with the narration mic on, the manual webm
// segments carry a live commentary track. Convention: utterances prefixed
// with "Edit:" are instructions for the edit ("Edit: speed this up until the
// timer expires", "Edit: zoom in on the create dialog"); everything else is
// material for the manuscript.
//
// This step extracts each manual segment's audio, transcribes it with
// word-level timestamps (ElevenLabs Scribe — same key as elevenTTS.js), splits
// it into utterances, and writes:
//
//   directives.vN.json    — "Edit:" utterances, anchored in SOURCE time
//                           ({segment, sourceSec}) so re-cuts never invalidate
//                           them, plus a mapped cutSec against the chosen EDL
//                           and recording-elapsed time for correlating with
//                           manifest events ("until the timer expires").
//   spoken-notes.vN.json  — everything else, in notes.json shape (t = cut
//                           output seconds), ready to merge with the dictated
//                           notes in the manuscript step.
//
// Compilation of directives into edits.vN.json / zoom keyframes is Claude's
// job (like the manuscript step): hand it directives.vN.json + manifest.json.
//
// API key: --key-file (default <dir>/.elevenlabs-key or parent) or
// $ELEVENLABS_API_KEY. Never logged.
//
// Options:
//   --edl <file>       EDL for source→cut mapping (default: latest edl.v*.json)
//   --language <code>  STT language hint (default: autodetect; sv/en both fine)
//   --gap <sec>        utterance split on silence gap (default 1.0)
//   --key-file <path>  API key file    --ffmpeg <path>

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const a = { dir: null, edl: null, language: null, gap: 1.0, keyFile: null, ffmpeg: process.env.FFMPEG || 'ffmpeg' };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--edl') a.edl = argv[++i];
    else if (x === '--language') a.language = argv[++i];
    else if (x === '--gap') a.gap = Number(argv[++i]);
    else if (x === '--key-file') a.keyFile = argv[++i];
    else if (x === '--ffmpeg') a.ffmpeg = argv[++i];
    else if (!x.startsWith('--')) a.dir = x;
  }
  return a;
}

function latest(dir, re) {
  const f = fs.readdirSync(dir).filter((x) => re.test(x))
    .sort((x, y) => (+(y.match(/v(\d+)/) || [0, 0])[1]) - (+(x.match(/v(\d+)/) || [0, 0])[1]));
  return f[0] ? path.join(dir, f[0]) : null;
}

function nextVersion(dir, base) {
  const re = new RegExp(`^${base}\\.v(\\d+)\\.json$`);
  const versions = fs.readdirSync(dir).map((f) => (f.match(re) || [])[1]).filter(Boolean).map(Number);
  return versions.length ? Math.max(...versions) + 1 : 1;
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 27 });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} failed: ${(r.stderr || '').split('\n').slice(-8).join('\n')}`);
  return r.stdout;
}

function hasAudioStream(ffmpeg, file) {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  try {
    const out = run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
    return out.trim().length > 0;
  } catch { return false; }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ─── ElevenLabs Scribe (speech-to-text, word timestamps) ────────────────────
function stt({ apiKey, file, language }) {
  return new Promise((resolve, reject) => {
    const boundary = '----demo' + Math.random().toString(36).slice(2);
    const fields = { model_id: 'scribe_v1', timestamps_granularity: 'word', tag_audio_events: 'false' };
    if (language) fields.language_code = language;
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(file)}"\r\nContent-Type: audio/mpeg\r\n\r\n`));
    parts.push(fs.readFileSync(file));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req = https.request({
      method: 'POST', hostname: 'api.elevenlabs.io', path: '/v1/speech-to-text',
      headers: {
        'xi-api-key': apiKey,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`STT ${res.statusCode}: ${text.slice(0, 300)}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`STT parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Words → utterances: split on silence gaps. Scribe emits word + spacing tokens
// with start/end seconds; we ignore spacing and break when the inter-word gap
// exceeds `gap`.
function toUtterances(words, gap) {
  const ws = (words || []).filter((w) => w.type === 'word' && typeof w.start === 'number');
  const utts = [];
  let cur = null;
  for (const w of ws) {
    if (cur && w.start - cur.end > gap) { utts.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end, text: w.text };
    else { cur.text += ' ' + w.text; cur.end = w.end; }
  }
  if (cur) utts.push(cur);
  for (const u of utts) u.text = u.text.replace(/\s+([,.!?;:])/g, '$1').trim();
  return utts;
}

// "Edit: …" (and Swedish "Redigera: …") marks an editing instruction. STT may
// render the delimiter as ":", ",", "." or nothing — accept any.
const EDIT_RE = /^(edit|redigera)\b[\s,:;.\-–]*/i;

// Map a source position (manual segment file + seconds into it) to the chosen
// cut's OUTPUT timeline by walking the EDL's clips in order.
function mapSourceToCut(edl, segmentFile, sourceSec) {
  let outStart = 0;
  for (const c of edl.clips || []) {
    const outDur = c.outDurationSec || 0;
    if (c.kind === 'manual' && c.source === segmentFile && sourceSec >= c.inSec - 0.01 && sourceSec <= c.outSec + 0.01) {
      return +(outStart + (sourceSec - c.inSec) / (c.speed || 1)).toFixed(2);
    }
    outStart += outDur;
  }
  return null; // position was cut out, or segment not in this EDL
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.dir) { console.error('Usage: node transcribeDirectives.js <recording-dir> [--edl <file>] [--language sv]'); process.exit(1); }
  const dir = path.resolve(args.dir);

  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { console.error(`No manifest.json in ${dir}`); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const keyCandidates = [args.keyFile, path.join(dir, '.elevenlabs-key'), path.join(dir, '..', '.elevenlabs-key')].filter(Boolean);
  const keyFile = keyCandidates.find((p) => fs.existsSync(p));
  const apiKey = process.env.ELEVENLABS_API_KEY || (keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : null);
  if (!apiKey) { console.error(`No API key ($ELEVENLABS_API_KEY or .elevenlabs-key in ${dir} or its parent)`); process.exit(1); }

  const edlPath = args.edl ? path.resolve(args.edl) : latest(dir, /^edl\.v\d+\.json$/);
  const edl = edlPath && fs.existsSync(edlPath) ? JSON.parse(fs.readFileSync(edlPath, 'utf8')) : null;
  if (!edl) console.log('No EDL found — directives will carry source time only (run roughCut.js first for cut mapping).');

  const manualSegs = (manifest.segments || []).filter((s) => s.kind === 'manual' && s.file);
  if (!manualSegs.length) { console.error('Manifest has no manual segments.'); process.exit(1); }

  const build = path.join(dir, '._stt_build');
  fs.mkdirSync(build, { recursive: true });

  const edits = [];
  const notes = [];

  for (const seg of manualSegs) {
    const src = path.join(dir, seg.file);
    if (!fs.existsSync(src)) { console.log(`  skip ${seg.file} (missing)`); continue; }
    if (!hasAudioStream(args.ffmpeg, src)) { console.log(`  skip ${seg.file} (no audio track — mic was off)`); continue; }

    const mp3 = path.join(build, path.basename(seg.file).replace(/\.\w+$/, '') + '.mp3');
    run(args.ffmpeg, ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '64k', mp3]);

    process.stdout.write(`  transcribing ${seg.file}… `);
    const res = await stt({ apiKey, file: mp3, language: args.language });
    const utts = toUtterances(res.words, args.gap);
    console.log(`${utts.length} utterances (${res.language_code || 'auto'})`);

    const segElapsedSec = (seg.startElapsedMs || 0) / 1000;
    for (const u of utts) {
      const isEdit = EDIT_RE.test(u.text);
      const entry = {
        segment: seg.file,
        sourceSec: +u.start.toFixed(2),
        sourceEndSec: +u.end.toFixed(2),
        elapsedSec: +(segElapsedSec + u.start).toFixed(2), // recording timeline, for manifest-event correlation
        cutSec: edl ? mapSourceToCut(edl, seg.file, u.start) : null,
        text: isEdit ? u.text.replace(EDIT_RE, '').trim() : u.text,
      };
      (isEdit ? edits : notes).push(entry);
    }
  }

  fs.rmSync(build, { recursive: true, force: true });

  const meta = {
    recording: path.basename(dir),
    generatedAt: new Date().toISOString(),
    edl: edl ? path.basename(edlPath) : null,
    language: args.language || 'auto',
  };

  const dv = nextVersion(dir, 'directives');
  const directivesOut = path.join(dir, `directives.v${dv}.json`);
  fs.writeFileSync(directivesOut, JSON.stringify({ meta, directives: edits }, null, 2));

  const nv = nextVersion(dir, 'spoken-notes');
  const notesOut = path.join(dir, `spoken-notes.v${nv}.json`);
  fs.writeFileSync(notesOut, JSON.stringify({
    meta,
    notes: notes.map((n, i) => ({
      id: `spoken-${i}`,
      t: n.cutSec != null ? n.cutSec : n.sourceSec,
      type: 'note',
      text: n.text,
      spoken: true,
      segment: n.segment,
      sourceSec: n.sourceSec,
      elapsedSec: n.elapsedSec,
    })),
  }, null, 2));

  console.log(`\n✓ ${path.basename(directivesOut)} — ${edits.length} edit directive(s)`);
  for (const e of edits) console.log(`    [${e.cutSec != null ? fmt(e.cutSec) + ' cut' : fmt(e.sourceSec) + ' src'}] ${e.text}`);
  console.log(`✓ ${path.basename(notesOut)} — ${notes.length} narration note(s)`);
  console.log(`\nNext: hand ${path.basename(directivesOut)} + manifest.json to Claude to compile edits.vN.json (timing) and zoom directives (framing), then editCut.js --render.`);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
