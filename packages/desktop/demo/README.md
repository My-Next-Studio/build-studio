# Demo Recording Mode

Records a full **draft → review → execution** product demo from inside the
Build Studio Electron app, ready to edit into a YouTube video.

Two capture regimes, switched **automatically** by watching the recorded
project's workflow:

| Regime | When | How | Why |
|--------|------|-----|-----|
| **Manual** | You're drafting / clicking (foreground) | `MediaRecorder` over the app's own window (~30fps webm) | Smooth typing & view transitions |
| **Automation** | A workflow is running (may be 1h+, backgrounded) | `webContents.capturePage()` timelapse | Keeps capturing while the app is behind other windows / on another Space; no OS screen-record permission |

## Using it

1. Open a project, go to **Development**.
2. In the top status bar, click **● REC** (only visible in the Electron app).
3. Draft / kick off the workflow as normal. The recorder switches to timelapse
   when automation starts and back to manual video when it finishes.
4. Controls in the bar while recording:
   - **interval** (1/2/5/10s) — timelapse cadence (auto: review 2s, execution 5s)
   - **🎤 on/off** — narration mic, mixed into the manual video (default on).
     Speak what you're doing as you go; prefix editing instructions with
     **"Edit:"** ("Edit: speed this up until the timer expires", "Edit: zoom
     in on the create dialog") — Step 1.5 turns those into machine-applied
     directives, everything else feeds the manuscript. Live-mutes; if the
     segment started muted it takes effect next segment.
   - **blur on/off** — heuristic auto-blur of detected secrets/paths
   - **⏸ privacy** — Privacy Pause: suspends *all* capture (incl. mic); the gap is logged
   - **■ stop** — finalizes the manifest and last segment

> **Demo setup button:** if the recorded project has `scripts/demo-setup.sh`,
> Operations → Services shows a **Demo setup** card — run it right before
> recording to seed demo data and put the iOS simulator in canonical demo mode
> (`xcrun simctl status_bar … --time "9:41" --batteryState charged …`). The
> script owns everything project-specific; the server runs it with a hard
> timeout (config `demo_setup_timeout_seconds`, default 180).
5. Output lands in a timestamped folder on the external drive, next to your
   projects: `…/demo-recordings/2026-06-11_14-30-00/`.

> **macOS permission:** the first manual segment triggers a one-time
> Screen-Recording permission prompt (System Settings → Privacy & Security →
> Screen Recording). Automation timelapse needs no permission.

## Output folder

```
2026-06-11_14-30-00/
  manifest.json            timeline: events, phase markers, segments
  manual/segment-01.webm   smooth manual video segment(s)
  automation-01/frame-*.jpg timelapse frames (one dir per automation run)
  events/0001-*.jpg        event screenshots (agent start/done, errors, result…)
```

`manifest.json` records, with wall-clock + elapsed offsets: `setup_started`,
`recording_started`, `automation_started`, `agent_started:*`,
`agent_completed:*`, step phases (`tests_running`, …), `progress_*pct`,
`error:*`, `final_result_ready`, `manual_resumed`, privacy gaps, and the
segment list.

## Post-production pipeline (recording → YouTube)

Repeatable and **non-destructive** — the recorded source (manual webm + timelapse
frames + manifest) is only ever *read*; every step writes new, versioned files,
so you can redo any stage. Run from the repo root; needs `ffmpeg` on PATH.

### 1 · Rough cut (≤5 min)
```bash
node packages/desktop/demo/roughCut.js <recording-folder> [--target 300] [--manual-share 0.6]
```
→ `edl.v1.json` + `rough-cut.v1.mp4` + `chapters.v1.txt`. Speed-ramps the manual
video and plays the automation runs as timelapse to hit the target. Open the mp4.

### 1.5 · Spoken directives → edits (if the mic was on)
```bash
node packages/desktop/demo/transcribeDirectives.js <recording-folder> [--language sv]
```
Extracts the narration track from the manual segments, transcribes with word
timestamps (ElevenLabs Scribe — same `.elevenlabs-key`), and splits utterances:

| spoken | lands in |
|--------|----------|
| `"Edit: …"` / `"Redigera: …"` | `directives.vN.json` — anchored in **source** time (re-cuts never invalidate them) + mapped to the current cut + recording-elapsed time for manifest-event references ("until the timer expires") |
| everything else | `spoken-notes.vN.json` — notes.json-shaped, merged into Step 4 |

Then hand `directives.vN.json` + `manifest.json` to Claude: timing directives
compile into an `edits.vN.json` for Step 2, framing directives ("zoom in on …")
into `zoom.json` for Step 6. Review the compiled files (or just watch the
resulting cut) before rendering — the ~10% the classifier gets wrong is cheap
to fix here.

### 2 · Re-cut from notes
Watch it, then adjust — either tell Claude in plain language, or write an
`edits.json` of speed changes against the **current cut's** timeline
(`factor > 1` = faster, `< 1` = slower/linger):
```json
[ { "from": 15,  "to": 60,  "factor": 2,   "note": "speed up" },
  { "from": 160, "to": 164, "factor": 0.5, "note": "linger" } ]
```
```bash
node packages/desktop/demo/editCut.js <recording>/edl.v1.json <recording>/edits.v2.json --render
```
→ `edl.v2.json` + `rough-cut.v2.mp4`. Clips split at the boundaries; iterate (v3…).
Re-render a hand-edited EDL: `node renderEdl.js <edl.json> [--crf 18] [--preset slow]`.

### 3 · Capture narration notes ⭐ (the convenient part)
```bash
node packages/desktop/demo/reviewNotes.js <recording-folder>   # serves :7788, opens browser
```
Plays the latest cut. **Pause anywhere, press `N`** — it stamps the *exact*
playhead time and pauses — then **dictate** the note (macOS dictation, or the 🎤
button; Svenska/English picker). No need to read timestamps aloud — the playhead
does it. Tag each note to steer the script:

| type | meaning |
|------|---------|
| `note` | your narration / what's happening |
| `highlight` | what to emphasize on screen here |
| `technical` | "add background here" — Claude fills it in |
| `cut` | trim this (feeds back into Step 2) |

Auto-saves to `notes.json`. macOS dictation tip: System Settings → Keyboard →
Dictation → On, shortcut "Press Control twice" (works on keyboards with no fn/globe).

### 4 · Manuscript
Hand `notes.json` to Claude. It maps each timestamp to the manifest event spine
(which agent/step is on screen), translates if needed (e.g. Swedish → English),
and writes a time-aligned `manus.vN.md` in one consistent voice, weaving in the
technical background the `technical` notes asked for.

### 5 · Narration (ElevenLabs) + upload master
```bash
node packages/desktop/demo/elevenTTS.js <recording-folder> --voice <voiceId> [--similarity 1.0]
```
Synthesizes each manuscript block in your cloned voice, lays it on a track at the
cut timestamps, and muxes → `combined-demo-draft.mp4` (+ `narration.m4a`). API key
from `.elevenlabs-key` (folder or its parent) or `$ELEVENLABS_API_KEY` — never
logged. (Tip: in the ElevenLabs UI "likhet"/similarity → 100% = `--similarity 1.0`.)

For the final upload, give YouTube a crisp source and 48 kHz stereo audio:
```bash
node packages/desktop/demo/renderEdl.js <recording>/edl.v2.json --crf 18 --preset slow --out <recording>/upload-video.mp4
ffmpeg -i <recording>/upload-video.mp4 -i <recording>/narration.m4a -filter_complex "[1:a]apad[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -ar 48000 -ac 2 -b:a 256k -shortest <recording>/upload-master.mp4
```
→ `upload-master.mp4` (H.264 High / 1080p30 / yuv420p + 48 kHz stereo AAC). Paste
`chapters.vN.txt` into the YouTube description. NB: a static screencast at CRF 18
has a low *average* bitrate — that's fine, it's a near-lossless source.

> **Quick one-shot** (no notes/voice): `node exportDemoVideo.js <recording>` just
> stitches manual + timelapse + chapters into a draft in a single command.

## Architecture

- **main process** (`demo/`, loaded from `main.js`): owns capture
  (`capturePage`), folder + manifest, privacy, and workflow-event detection.
  - `demoRecorder.js` — orchestrator (mode switching, timelapse, event polling)
  - `demoRecordingManifest.js` — timeline / manifest writer
  - `demoPrivacyMode.js` — Privacy Pause + auto-blur (CSS injected into the page)
- **preload** (`preload.js`): exposes `window.demoRecorder` (IPC bridge)
- **renderer** (hub): `components/demo-recording-control.tsx` (top-bar UI) +
  `lib/demo-recording-client.ts` (manual-mode `MediaRecorder`)
- **post-production** (standalone CLIs, run outside the app):
  - `edl.js` — EDL model: plan (`buildAutoEdl`), edits (`applyEdits`), render (`renderEdl`), chapters
  - `roughCut.js` / `editCut.js` / `renderEdl.js` — cut + re-cut CLIs
  - `reviewNotes.js` + `annotate.html` — timestamped note capture (local player + server)
  - `transcribeDirectives.js` — live-narration STT → "Edit:" directives + spoken notes
  - `elevenTTS.js` — ElevenLabs narration + mux
  - `exportDemoVideo.js` — quick one-shot stitch (no notes/voice)

> **Possible enhancement — fold post-production into the app.** A "Demos" tab
> could list recordings and expose rough-cut / annotate / narrate as buttons, so
> the whole flow lives in Build Studio instead of CLIs. The annotate step
> (`reviewNotes.js` + `annotate.html`) already runs as a local web page, so it
> would drop into the hub UI with little change.

### Deploying changes

Renderer changes: rebuild hub + `inject-resources.js` (as usual). **Main-process
changes** (`main.js`, `preload.js`, `demo/*`) live in `app.asar`, which
`inject-resources.js` does *not* touch — repack and redeploy:

```bash
cd packages/hub && npx next build
cd packages/desktop && npm run pack          # fresh app.asar in dist/
cp "dist/mac-arm64/Build Studio.app/Contents/Resources/app.asar" \
   "/Applications/Build Studio.app/Contents/Resources/app.asar"
node inject-resources.js                      # sync standalone into both
# then relaunch the app
```
