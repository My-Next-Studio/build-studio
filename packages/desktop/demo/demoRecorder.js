// Demo Recording — orchestrator (Electron main process).
//
// Owns a recording SESSION end to end:
//   • creates a timestamped output folder on the external drive
//   • MANUAL mode: tells the renderer to record smooth window video
//     (MediaRecorder) and writes the streamed chunks to disk
//   • AUTOMATION mode: low-frequency `webContents.capturePage()` timelapse that
//     keeps working while the app is backgrounded / on another Space
//   • auto-switches manual↔automation by polling the recording project's
//     /api/workflow, and drops event screenshots + phase markers on the way
//   • drives demoPrivacyMode (pause + auto-blur) and the manifest
//
// Decoupled from main.js globals via injected deps (getWindow, send,
// fetchWorkflow) so it stays testable and main.js stays thin.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { DemoRecordingManifest } = require('./demoRecordingManifest');
const { DemoPrivacyMode } = require('./demoPrivacyMode');

// Auto interval per workflow type (req 3 "be clever"): review is short so we
// sample fast; execution can run 1h+ so we sample slow. Overridable from the UI.
const AUTO_INTERVAL_SEC = { review: 2, execution: 5, kickoff: 3, onboarding: 3 };
const DEFAULT_INTERVAL_SEC = 5;
const ALLOWED_INTERVALS = [1, 2, 5, 10];
const MANUAL_FPS = 30;          // target smoothness for manual video
const TIMELAPSE_JPEG_QUALITY = 80;
const EVENT_JPEG_QUALITY = 90;

// Friendlier phase labels for the timeline where the raw step key is cryptic.
const STEP_PHASE_LABEL = {
  qa_tests: 'tests_running',
  qa_validation: 'tests_running',
  task_execution: 'implementation_running',
  reviewing: 'review_running',
  pm_draft: 'drafting',
  security_audit: 'security_audit',
  merge_to_main: 'merging',
  capture_learnings: 'wrapping_up',
};

function pad(n, w = 6) { return String(n).padStart(w, '0'); }

// Longest common parent directory of a set of absolute paths.
function commonParent(paths) {
  if (!paths.length) return null;
  const split = paths.map((p) => path.resolve(p).split(path.sep));
  const first = split[0];
  const out = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (split.every((s) => s[i] === seg)) out.push(seg); else break;
  }
  const joined = out.join(path.sep);
  return joined || null;
}

// Output base: env override → next to the managed projects (which sit beside
// the build-studio repo on the external drive) → ~/Movies fallback.
function resolveBaseDir() {
  if (process.env.DEMO_RECORDINGS_DIR) return process.env.DEMO_RECORDINGS_DIR;
  try {
    const shared = require('@build-studio/shared');
    const projects = shared.registry.list().map((p) => p.path).filter(Boolean);
    const parent = commonParent(projects);
    // Guard against a uselessly-shallow common root (e.g. '/' or '/Volumes').
    if (parent && parent.split(path.sep).filter(Boolean).length >= 2) {
      return path.join(parent, 'demo-recordings');
    }
  } catch (_) { /* registry not resolvable — fall through */ }
  return path.join(os.homedir(), 'Movies', 'build-studio-demos');
}

function timestampFolder(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class DemoRecorder {
  constructor({ getWindow, send, fetchWorkflow, now = () => Date.now() }) {
    this.getWindow = getWindow;          // () => BrowserWindow|null
    this.send = send;                    // (channel, payload) => void  (main→renderer)
    this.fetchWorkflow = fetchWorkflow;  // (port) => Promise<any>
    this.now = now;

    this.session = null; // active session state, or null
  }

  isRecording() { return !!this.session; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(opts = {}) {
    if (this.session) return this.getStatus();
    const win = this.getWindow();
    if (!win) throw new Error('no app window to record');

    const startMs = this.now();
    const baseDir = resolveBaseDir();
    const dir = path.join(baseDir, timestampFolder(new Date(startMs)));
    fs.mkdirSync(path.join(dir, 'manual'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'events'), { recursive: true });

    const manifest = new DemoRecordingManifest(dir, {
      project: opts.projectName || null,
      startedAt: startMs,
    });

    const privacy = new DemoPrivacyMode(win.webContents);

    this.session = {
      dir,
      startMs,
      project: opts.projectName || null,
      port: opts.port || null,
      mode: null,                       // set by _enterManual/_enterAutomation
      intervalOverrideSec: ALLOWED_INTERVALS.includes(opts.automationIntervalSec)
        ? opts.automationIntervalSec : null,
      manifest,
      privacy,
      timelapseTimer: null,
      timelapseSeq: 0,
      automationSegIndex: 0,
      manualSegIndex: 0,
      manualStream: null,
      manualStreamPath: null,
      // Live references to the open manifest segments so we close the RIGHT one
      // (manual close races the automation segment add → "last segment" is wrong).
      currentManualSeg: null,
      currentAutomationSeg: null,
      lastManualSeg: null,              // closed manual seg awaiting renderer codec/duration meta
      eventSeq: 0,
      pollTimer: null,
      lastWf: null,
      startedAgentKeys: new Set(),
      finishedAgentKeys: new Set(),
      lastProgressBucket: -1,
      lastStep: null,
    };

    // Keep painting + timers alive when the window is backgrounded so the
    // timelapse and the page itself don't freeze during long automation.
    try { win.webContents.setBackgroundThrottling(false); } catch (_) {}

    manifest.event(startMs, 'setup_started', { type: 'system', meta: { project: this.session.project } });
    manifest.event(startMs, 'recording_started', { type: 'system' });
    manifest.write();

    if (opts.blur !== false) await privacy.enableBlur();

    // Begin in manual mode (the owner drafts/clicks first).
    this._enterManual({ initial: true });

    // Start watching the project's workflow to auto-switch + drop events.
    if (this.session.port) {
      this.session.pollTimer = setInterval(() => this._pollWorkflow().catch(() => {}), 2000);
      this._pollWorkflow().catch(() => {});
    }

    this._broadcast();
    return this.getStatus();
  }

  async stop() {
    const s = this.session;
    if (!s) return { recording: false };
    const endMs = this.now();

    if (s.pollTimer) clearInterval(s.pollTimer);
    this._stopTimelapse(endMs);
    // Close the manual segment timing deterministically, then flush its file.
    if (s.currentManualSeg) { s.manifest.closeSegment(s.currentManualSeg, endMs); s.lastManualSeg = s.currentManualSeg; s.currentManualSeg = null; }
    await this._stopManualStream();
    await s.privacy.dispose();

    s.manifest.event(endMs, 'recording_stopped', { type: 'system' });
    s.manifest.finish(endMs);
    s.manifest.write();

    const dir = s.dir;
    this.session = null;
    this._broadcast();
    return { recording: false, dir };
  }

  // ── mode switching ───────────────────────────────────────────────────────────

  _enterManual({ initial = false } = {}) {
    const s = this.session;
    if (!s || s.mode === 'manual') return;
    const nowMs = this.now();
    this._stopTimelapse(nowMs);
    s.mode = 'manual';
    if (!initial) s.manifest.event(nowMs, 'manual_resumed', { type: 'phase' });

    // Tell the renderer to start a fresh manual video segment.
    s.manualSegIndex += 1;
    const file = path.join(s.dir, 'manual', `segment-${pad(s.manualSegIndex, 2)}.webm`);
    s.manualStreamPath = file;
    s.manualStream = fs.createWriteStream(file);
    s.currentManualSeg = s.manifest.addSegment({ kind: 'manual', file: path.relative(s.dir, file), startMs: nowMs, fps: MANUAL_FPS, mime: 'video/webm' });
    this.send('demo:command', { action: 'start-manual', fps: MANUAL_FPS });
    this._broadcast();
  }

  _enterAutomation(wf) {
    const s = this.session;
    if (!s || s.mode === 'automation') return;
    const nowMs = this.now();

    // Close the manual segment's timing NOW (deterministic — avoids racing the
    // automation segment we're about to add), then flush its video file (async).
    if (s.currentManualSeg) { s.manifest.closeSegment(s.currentManualSeg, nowMs); s.lastManualSeg = s.currentManualSeg; s.currentManualSeg = null; }
    this._stopManualStream().catch(() => {});

    s.mode = 'automation';
    s.automationSegIndex += 1;
    s.timelapseSeq = 0;
    const segDir = path.join(s.dir, `automation-${pad(s.automationSegIndex, 2)}`);
    fs.mkdirSync(segDir, { recursive: true });
    s.timelapseDir = segDir;

    const intervalSec = this._currentIntervalSec(wf);
    s.currentAutomationSeg = s.manifest.addSegment({
      kind: 'automation', dir: path.relative(s.dir, segDir), startMs: nowMs,
      intervalSec, workflowType: wf && wf.type,
    });
    // _eventShot records the manifest 'automation_started' marker (with a frame)
    // — no separate manifest.event() call, or it would be logged twice.
    this._eventShot('automation_started', { type: 'phase', meta: { workflowType: wf && wf.type, intervalSec } });
    this._startTimelapse(intervalSec);
    this._broadcast();
  }

  _currentIntervalSec(wf) {
    const s = this.session;
    if (s && s.intervalOverrideSec) return s.intervalOverrideSec;
    const type = wf && wf.type;
    return AUTO_INTERVAL_SEC[type] || DEFAULT_INTERVAL_SEC;
  }

  // ── timelapse (automation) ───────────────────────────────────────────────────

  _startTimelapse(intervalSec) {
    const s = this.session;
    if (s.timelapseTimer) clearInterval(s.timelapseTimer);
    s.timelapseTimer = setInterval(() => this._timelapseTick().catch(() => {}), intervalSec * 1000);
  }

  async _timelapseTick() {
    const s = this.session;
    if (!s || s.mode !== 'automation') return;
    if (s.privacy.isPaused()) return; // Privacy Pause → skip frame, leaves a gap
    const win = this.getWindow();
    if (!win) return;
    try {
      const img = await win.webContents.capturePage();
      if (img.isEmpty()) return;
      s.timelapseSeq += 1;
      const file = path.join(s.timelapseDir, `frame-${pad(s.timelapseSeq)}.jpg`);
      fs.writeFileSync(file, img.toJPEG(TIMELAPSE_JPEG_QUALITY));
      if (s.timelapseSeq % 5 === 0) this._broadcast(); // throttle UI updates
    } catch (e) {
      console.error('[demo] timelapse capture failed:', e.message);
    }
  }

  _stopTimelapse(nowMs) {
    const s = this.session;
    if (!s || !s.timelapseTimer) return;
    clearInterval(s.timelapseTimer);
    s.timelapseTimer = null;
    if (s.currentAutomationSeg) { s.manifest.closeSegment(s.currentAutomationSeg, nowMs, { frameCount: s.timelapseSeq }); s.currentAutomationSeg = null; }
    s.manifest.write();
  }

  // ── manual video (renderer-driven) ───────────────────────────────────────────

  // Called from main's IPC handler when the renderer streams a chunk.
  onVideoChunk(buf) {
    const s = this.session;
    if (s && s.manualStream && buf && buf.length) s.manualStream.write(Buffer.from(buf));
  }

  // Called from main when the renderer confirms its MediaRecorder fully stopped.
  // Segment TIMING is already closed at the mode transition; here we just close
  // the file stream and attach codec/duration metadata to that segment.
  onManualStopped(meta = {}) {
    const s = this.session;
    if (!s) return;
    if (s.manualStream) { const stream = s.manualStream; s.manualStream = null; stream.end(); }
    const seg = s.lastManualSeg || s.currentManualSeg;
    if (seg) {
      if (meta.mime) seg.mime = meta.mime;
      if (meta.durationMs) seg.recordedMs = meta.durationMs;
      s.manifest.write();
    }
  }

  // Ask the renderer to flush + stop its MediaRecorder, then ensure the file
  // stream is closed. File-only — manifest segment timing is set by the caller.
  async _stopManualStream() {
    const s = this.session;
    if (!s) return;
    this.send('demo:command', { action: 'stop-manual' });
    if (!s.manualStream) return;
    const deadline = Date.now() + 1500; // wait for the renderer's last chunk + ack
    while (s.manualStream && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (s.manualStream) { const stream = s.manualStream; s.manualStream = null; stream.end(); }
  }

  // ── event screenshots ────────────────────────────────────────────────────────

  async _eventShot(label, { type = 'phase', meta = {} } = {}) {
    const s = this.session;
    if (!s) return;
    if (s.privacy.isPaused()) { s.manifest.event(this.now(), label, { type, meta }); s.manifest.write(); return; }
    const win = this.getWindow();
    let frameRel = null;
    if (win) {
      try {
        const img = await win.webContents.capturePage();
        if (!img.isEmpty()) {
          s.eventSeq += 1;
          const safe = label.replace(/[^a-z0-9_-]/gi, '-');
          const file = path.join(s.dir, 'events', `${pad(s.eventSeq, 4)}-${safe}.jpg`);
          fs.writeFileSync(file, img.toJPEG(EVENT_JPEG_QUALITY));
          frameRel = path.relative(s.dir, file);
        }
      } catch (e) { console.error('[demo] event shot failed:', e.message); }
    }
    s.manifest.event(this.now(), label, { type, meta, frame: frameRel });
    s.manifest.write();
  }

  // A manifest-only marker (no screenshot) — used for high-level UI marks like
  // prompt_entered that the renderer reports.
  mark(label, meta = {}) {
    const s = this.session;
    if (!s) return;
    s.manifest.event(this.now(), label, { type: 'phase', meta });
    s.manifest.write();
    this._broadcast();
  }

  // ── workflow polling → events + auto mode switch ─────────────────────────────

  async _pollWorkflow() {
    const s = this.session;
    if (!s || !s.port) return;
    const resp = await this.fetchWorkflow(s.port);
    const wf = resp && (resp.workflow !== undefined ? resp.workflow : resp);
    const active = !!(wf && wf.currentStep && wf.currentStep !== 'completed');
    const wasActive = s.mode === 'automation';

    if (active && !wasActive) {
      this._enterAutomation(wf);
    }

    if (active) {
      this._detectWorkflowEvents(wf);
    }

    if (!active && wasActive) {
      // Workflow finished → grab the result frame, return to manual.
      await this._eventShot('final_result_ready', { type: 'result', meta: { step: wf && wf.currentStep } });
      this._enterManual({});
    }

    s.lastWf = wf;
    s.lastStep = wf && wf.currentStep;
    this._broadcast();
  }

  _detectWorkflowEvents(wf) {
    const s = this.session;

    // Step changes.
    if (wf.currentStep && wf.currentStep !== s.lastStep) {
      const label = STEP_PHASE_LABEL[wf.currentStep] || `step_started:${wf.currentStep}`;
      this._eventShot(label, { type: 'step', meta: { step: wf.currentStep } });
    }

    // Agent start / complete / error across the current step + task agents.
    const agents = this._collectAgents(wf);
    for (const a of agents) {
      const running = a.status === 'running' || a.status === 'active' || a.status === 'in_progress';
      const done = a.status === 'done' || a.status === 'completed';
      const errored = a.status === 'error' || a.status === 'failed';
      if (running && !s.startedAgentKeys.has(a.key)) {
        s.startedAgentKeys.add(a.key);
        this._eventShot(`agent_started:${a.label}`, { type: 'agent', meta: { agent: a.label, step: a.step } });
      }
      if ((done || errored) && !s.finishedAgentKeys.has(a.key)) {
        s.finishedAgentKeys.add(a.key);
        if (errored) this._eventShot(`error:${a.label}`, { type: 'error', meta: { agent: a.label, step: a.step } });
        else this._eventShot(`agent_completed:${a.label}`, { type: 'agent', meta: { agent: a.label, step: a.step } });
      }
    }

    // Step-level error/blocked.
    const cur = wf.steps && wf.steps[wf.currentStep];
    if (cur && (cur.status === 'error' || cur.status === 'blocked')) {
      const key = `steperr:${wf.currentStep}`;
      if (!s.finishedAgentKeys.has(key)) {
        s.finishedAgentKeys.add(key);
        this._eventShot(`error:${wf.currentStep}`, { type: 'error', meta: { step: wf.currentStep, status: cur.status } });
      }
    }

    // Progress in 5% buckets.
    const pct = this._progressPct(wf);
    const bucket = Math.floor(pct / 5);
    if (bucket > s.lastProgressBucket) {
      s.lastProgressBucket = bucket;
      if (pct > 0 && pct < 100) this._eventShot(`progress_${bucket * 5}pct`, { type: 'progress', meta: { percent: bucket * 5 } });
    }
  }

  _collectAgents(wf) {
    const out = [];
    const push = (a, step, scope) => {
      if (!a) return;
      const label = a.role || a.name || a.agent || 'agent';
      out.push({ key: `${scope}:${label}`, label, step, status: a.status });
    };
    // Scan ALL steps, not just the current one: an agent often only reaches
    // 'done' a poll or two after the workflow has already advanced to the next
    // step, so a current-step-only scan would miss its completion event.
    if (wf.steps) {
      for (const [stepKey, step] of Object.entries(wf.steps)) {
        if (step && Array.isArray(step.agents)) step.agents.forEach((a, i) => push(a, stepKey, `${stepKey}#${i}`));
      }
    }
    if (wf.taskExecution && wf.taskExecution.taskStates) {
      for (const [idx, ts] of Object.entries(wf.taskExecution.taskStates)) {
        (ts.agents || []).forEach((a, i) => push(a, `task_execution`, `task${idx}#${i}`));
      }
    }
    return out;
  }

  _progressPct(wf) {
    const steps = wf.steps ? Object.values(wf.steps) : [];
    if (!steps.length) return 0;
    const done = steps.filter((st) => st.status === 'completed' || st.status === 'done').length;
    return Math.round((done / steps.length) * 100);
  }

  _currentAgentLabel(wf) {
    const cur = wf && wf.steps && wf.steps[wf.currentStep];
    const running = cur && (cur.agents || []).find((a) => ['running', 'active', 'in_progress'].includes(a.status));
    return running ? (running.role || running.name || null) : null;
  }

  // ── controls + status ────────────────────────────────────────────────────────

  setAutomationInterval(sec) {
    const s = this.session;
    if (!s || !ALLOWED_INTERVALS.includes(sec)) return this.getStatus();
    s.intervalOverrideSec = sec;
    if (s.mode === 'automation') this._startTimelapse(sec); // re-arm at new cadence
    s.manifest.event(this.now(), 'interval_changed', { type: 'system', meta: { intervalSec: sec } });
    s.manifest.write();
    this._broadcast();
    return this.getStatus();
  }

  privacyPause(on) {
    const s = this.session;
    if (!s) return this.getStatus();
    if (on) s.privacy.pause(); else s.privacy.resume();
    s.manifest.event(this.now(), on ? 'privacy_paused' : 'privacy_resumed', { type: 'privacy' });
    s.manifest.write();
    // Manual video also pauses in the renderer.
    this.send('demo:command', { action: on ? 'pause-manual' : 'resume-manual' });
    this._broadcast();
    return this.getStatus();
  }

  async setBlur(on) {
    const s = this.session;
    if (!s) return this.getStatus();
    if (on) await s.privacy.enableBlur(); else await s.privacy.disableBlur();
    this._broadcast();
    return this.getStatus();
  }

  getStatus() {
    const s = this.session;
    if (!s) return { recording: false };
    const wf = s.lastWf;
    return {
      recording: true,
      dir: s.dir,
      project: s.project,
      mode: s.mode,
      elapsedMs: this.now() - s.startMs,
      automationIntervalSec: this._currentIntervalSec(wf),
      intervalOverride: s.intervalOverrideSec,
      timelapseFrames: s.timelapseSeq,
      privacyPaused: s.privacy.isPaused(),
      blur: s.privacy.isBlurEnabled(),
      currentStep: wf && wf.currentStep,
      currentAgent: this._currentAgentLabel(wf),
      progress: wf ? this._progressPct(wf) : 0,
      eventCount: s.manifest.toJSON().events.length,
    };
  }

  _broadcast() {
    try { this.send('demo:state', this.getStatus()); } catch (_) {}
  }
}

module.exports = { DemoRecorder, resolveBaseDir, ALLOWED_INTERVALS, AUTO_INTERVAL_SEC };
