#!/usr/bin/env node
// Demo Recording — Step 4: narration via ElevenLabs, muxed onto the cut.
//
//   node packages/desktop/demo/elevenTTS.js <recording-dir> --voice <id> [options]
//
// Parses the manuscript (manus.v*.md), synthesizes each timestamped block in
// your cloned voice, lays the blocks onto a narration track at their cut
// timestamps (silence between), and muxes that onto the chosen rough cut →
// combined-demo-draft.mp4. Source clips + the cut are never modified.
//
// API key: --key-file (default <dir>/.elevenlabs-key) or $ELEVENLABS_API_KEY.
// The key is read from disk and sent only to api.elevenlabs.io — never logged.
//
// Options:
//   --voice <id>          ElevenLabs voice id (or $ELEVEN_VOICE_ID)        [required]
//   --manus <file>        manuscript (default: latest manus.v*.md in dir)
//   --cut <file>          video to narrate (default: latest rough-cut.v*.mp4)
//   --model <id>          TTS model (default eleven_multilingual_v2)
//   --similarity <0..1>   voice_settings.similarity_boost (default 1.0 — "likhet")
//   --stability <0..1>    (default 0.5)   --style <0..1> (default 0)
//   --key-file <path>     API key file    --ffmpeg <path>

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const a = {
    dir: null, voice: process.env.ELEVEN_VOICE_ID || null, manus: null, cut: null,
    model: 'eleven_multilingual_v2', similarity: 1.0, stability: 0.5, style: 0.0,
    keyFile: null, ffmpeg: process.env.FFMPEG || 'ffmpeg',
  };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--voice') a.voice = argv[++i];
    else if (x === '--manus') a.manus = argv[++i];
    else if (x === '--cut') a.cut = argv[++i];
    else if (x === '--model') a.model = argv[++i];
    else if (x === '--similarity') a.similarity = Number(argv[++i]);
    else if (x === '--stability') a.stability = Number(argv[++i]);
    else if (x === '--style') a.style = Number(argv[++i]);
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

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 27 });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} failed: ${(r.stderr || '').split('\n').slice(-8).join('\n')}`);
  return r.stdout;
}
function probe(ffmpeg, file) {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  const out = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return parseFloat(out.trim()) || 0;
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse manus.v*.md → [{ start, end, text }] (timestamps in cut output seconds).
function parseManus(md) {
  const hdr = /^\*\*\[(\d+):(\d+)(?:\s*[–-]\s*(\d+):(\d+))?\]/;
  const segs = []; let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(hdr);
    if (m) {
      if (cur) segs.push(cur);
      cur = { start: (+m[1]) * 60 + (+m[2]), end: m[3] != null ? (+m[3]) * 60 + (+m[4]) : null, text: '' };
    } else if (cur) {
      const t = line.trim();
      if (t) cur.text += (cur.text ? ' ' : '') + t;
    }
  }
  if (cur) segs.push(cur);
  for (const s of segs) s.text = s.text.replace(/[*_`]/g, '').trim();
  return segs.filter((s) => s.text);
}

function tts({ apiKey, voiceId, text, model, settings, outFile }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text, model_id: model, voice_settings: settings });
    const req = https.request({
      method: 'POST', hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(`TTS ${res.statusCode}: ${buf.toString('utf8').slice(0, 300)}`));
        fs.writeFileSync(outFile, buf); resolve();
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.dir) { console.error('Usage: node elevenTTS.js <recording-dir> --voice <id>'); process.exit(1); }
  const dir = path.resolve(args.dir);
  if (!args.voice) { console.error('Missing --voice <id> (or $ELEVEN_VOICE_ID)'); process.exit(1); }

  // Key: explicit flag → env → <dir>/.elevenlabs-key → <dir>/../.elevenlabs-key (recordings root)
  const keyCandidates = [args.keyFile, path.join(dir, '.elevenlabs-key'), path.join(dir, '..', '.elevenlabs-key')].filter(Boolean);
  const keyFile = keyCandidates.find((p) => fs.existsSync(p));
  const apiKey = process.env.ELEVENLABS_API_KEY || (keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : null);
  if (!apiKey) { console.error(`No API key ($ELEVENLABS_API_KEY or .elevenlabs-key in ${dir} or its parent)`); process.exit(1); }

  const manusPath = args.manus ? path.resolve(args.manus) : latest(dir, /^manus\.v\d+\.md$/);
  const cutPath = args.cut ? path.resolve(args.cut) : latest(dir, /^rough-cut\.v\d+\.mp4$/);
  if (!manusPath || !fs.existsSync(manusPath)) { console.error('No manuscript found.'); process.exit(1); }
  if (!cutPath || !fs.existsSync(cutPath)) { console.error('No rough-cut mp4 found.'); process.exit(1); }

  const segs = parseManus(fs.readFileSync(manusPath, 'utf8'));
  const settings = { stability: args.stability, similarity_boost: args.similarity, style: args.style, use_speaker_boost: true };
  const narrDir = path.join(dir, 'narration');
  fs.mkdirSync(narrDir, { recursive: true });

  console.log(`Narrating ${path.basename(manusPath)} → ${segs.length} blocks (voice ${args.voice}, similarity ${args.similarity})`);

  // 1) synth each block
  for (let i = 0; i < segs.length; i++) {
    const out = path.join(narrDir, `seg-${String(i).padStart(2, '0')}.mp3`);
    process.stdout.write(`  [${fmt(segs[i].start)}] block ${i + 1}/${segs.length}… `);
    await tts({ apiKey, voiceId: args.voice, text: segs[i].text, model: args.model, settings, outFile: out });
    segs[i].audio = out; segs[i].audioDur = probe(args.ffmpeg, out);
    const slot = (segs[i + 1] ? segs[i + 1].start : (segs[i].end || segs[i].start + segs[i].audioDur)) - segs[i].start;
    segs[i].slot = slot;
    console.log(`${segs[i].audioDur.toFixed(1)}s / ${slot.toFixed(1)}s slot ${segs[i].audioDur > slot + 0.3 ? '⚠ over' : '✓'}`);
    await sleep(250);
  }

  // 2) lay blocks on a timeline at their start times (silence between)
  const build = path.join(dir, '._tts_build');
  fs.mkdirSync(build, { recursive: true });
  const pieces = []; let cursor = 0, si = 0;
  const silence = (sec) => {
    const f = path.join(build, `sil-${si++}.mp3`);
    run(args.ffmpeg, ['-y', '-f', 'lavfi', '-t', sec.toFixed(3), '-i', 'anullsrc=channel_layout=mono:sample_rate=44100', '-c:a', 'libmp3lame', '-b:a', '128k', f]);
    return f;
  };
  for (const s of segs) {
    if (s.start > cursor + 0.05) { pieces.push(silence(s.start - cursor)); cursor = s.start; }
    pieces.push(s.audio); cursor += s.audioDur;
  }
  const listFile = path.join(build, 'list.txt');
  fs.writeFileSync(listFile, pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  const narration = path.join(dir, 'narration.m4a');
  run(args.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'aac', '-b:a', '192k', narration]);

  // 3) mux onto the cut, padding the shorter stream so nothing is clipped
  const vDur = probe(args.ffmpeg, cutPath), nDur = probe(args.ffmpeg, narration);
  const out = path.join(dir, 'combined-demo-draft.mp4');
  if (nDur <= vDur + 0.05) {
    run(args.ffmpeg, ['-y', '-i', cutPath, '-i', narration, '-filter_complex', '[1:a]apad[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', vDur.toFixed(2), out]);
  } else {
    const pad = (nDur - vDur).toFixed(2);
    run(args.ffmpeg, ['-y', '-i', cutPath, '-i', narration, '-filter_complex', `[0:v]tpad=stop_mode=clone:stop_duration=${pad}[v]`, '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', nDur.toFixed(2), out]);
  }
  fs.rmSync(build, { recursive: true, force: true });

  const over = segs.filter((s) => s.audioDur > s.slot + 0.3);
  console.log(`\n✓ ${path.basename(out)}  (video ${fmt(vDur)}, narration ${fmt(nDur)})`);
  console.log(`  narration.m4a + per-block mp3s in narration/`);
  if (over.length) console.log(`  ⚠ ${over.length} block(s) run past their slot — trim text or we re-time those shots: ${over.map((s) => fmt(s.start)).join(', ')}`);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
