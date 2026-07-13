// Demo Recording — timeline / manifest writer.
//
// One manifest.json per recording session. It captures:
//   - session metadata (project, start time, output dir)
//   - a flat, ordered list of timeline EVENTS (phase markers + app events),
//     each with a wall-clock timestamp and elapsed-ms offset
//   - the list of SEGMENTS (manual video files + automation timelapse dirs)
//     so the export step can stitch them back together in order
//
// This module is pure data + atomic file I/O. It holds no Electron references
// and knows nothing about capture — demoRecorder.js drives it.

const fs = require('fs');
const path = require('path');

class DemoRecordingManifest {
  constructor(sessionDir, { project = null, startedAt = null } = {}) {
    this.sessionDir = sessionDir;
    this.manifestPath = path.join(sessionDir, 'manifest.json');
    // startedAt is supplied by the caller (main process owns the clock) so the
    // manifest never calls Date.now() itself — keeps it deterministic/testable.
    this.startedAtMs = startedAt != null ? startedAt : 0;
    this.data = {
      version: 1,
      project,
      createdAtIso: new Date(this.startedAtMs).toISOString(),
      startedAtMs: this.startedAtMs,
      endedAtMs: null,
      // ffmpeg target the export script honours (req 7).
      output: { width: 1920, height: 1080, fps: 30, codec: 'h264', pixfmt: 'yuv420p' },
      events: [],
      segments: [],
    };
  }

  _elapsed(nowMs) {
    return Math.max(0, nowMs - this.startedAtMs);
  }

  /**
   * Append a timeline event. `label` is the phase marker / event name
   * (e.g. 'automation_started', 'agent_1_started'). `type` groups events for
   * the editor ('phase' | 'agent' | 'step' | 'progress' | 'error' | 'result' |
   * 'privacy' | 'system'). `frame` is an optional path (relative to sessionDir)
   * to an event screenshot. `meta` carries any extra context (agent name,
   * step key, progress %, current elapsed).
   */
  event(nowMs, label, { type = 'phase', meta = {}, frame = null } = {}) {
    this.data.events.push({
      t: new Date(nowMs).toISOString(),
      elapsedMs: this._elapsed(nowMs),
      label,
      type,
      ...(frame ? { frame } : {}),
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    });
    return this.data.events[this.data.events.length - 1];
  }

  /**
   * Register a capture segment. Manual segments are a single video file;
   * automation segments are a directory of timelapse frames. The export step
   * walks segments in start order to build the combined draft.
   */
  addSegment(seg) {
    // seg: { kind:'manual'|'automation', startMs, endMs, ... }
    const entry = {
      ...seg,
      startElapsedMs: this._elapsed(seg.startMs),
      endElapsedMs: seg.endMs != null ? this._elapsed(seg.endMs) : null,
    };
    this.data.segments.push(entry);
    return entry;
  }

  /**
   * Close a SPECIFIC segment by reference (set endMs/endElapsedMs + patch).
   * Use this rather than closeLastSegment: manual and automation segments
   * interleave, so the "last" segment is often not the one being closed.
   */
  closeSegment(seg, nowMs, patch = {}) {
    if (!seg) return null;
    Object.assign(seg, patch, { endMs: nowMs, endElapsedMs: this._elapsed(nowMs) });
    return seg;
  }

  /** Patch the most recently added segment (e.g. to set endMs + frameCount). */
  closeLastSegment(nowMs, patch = {}) {
    return this.closeSegment(this.data.segments[this.data.segments.length - 1], nowMs, patch);
  }

  finish(nowMs) {
    this.data.endedAtMs = nowMs;
    this.data.durationMs = this._elapsed(nowMs);
  }

  toJSON() {
    return this.data;
  }

  /** Atomic write — safe to call repeatedly for live updates during a session. */
  write() {
    const tmp = this.manifestPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.manifestPath);
  }
}

module.exports = { DemoRecordingManifest };
