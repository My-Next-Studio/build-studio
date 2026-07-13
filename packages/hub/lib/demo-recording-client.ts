// Renderer side of Demo Recording.
//
// The main process owns the session; this module owns ONLY the manual-mode
// window video. Main tells us when to start/stop/pause a manual segment (via
// the `window.demoRecorder` preload bridge) and we run a MediaRecorder over the
// app's own window (auto-granted by main's setDisplayMediaRequestHandler),
// streaming chunks back to main to write to disk.
//
// Mic narration: when enabled, a microphone track is mixed into the same
// MediaRecorder so the manual webm carries an opus audio track, time-aligned
// with the video for free. Spoken "Edit: …" utterances on that track become
// machine-applied cut directives in post (transcribeDirectives.js); everything
// else feeds the manuscript step.
//
// Automation timelapse is captured entirely in main (capturePage) and needs
// nothing here — so even if manual video fails (e.g. Screen-Recording
// permission denied) the long automation capture is unaffected.

type DR = {
  available: boolean
  sendVideoChunk: (buf: ArrayBuffer) => void
  manualStopped: (meta: Record<string, unknown>) => void
  onCommand: (cb: (cmd: { action: string; fps?: number }) => void) => () => void
  onState: (cb: (s: unknown) => void) => () => void
}

function getDR(): DR | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { demoRecorder?: DR }).demoRecorder ?? null
}

let initialized = false
let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let micStream: MediaStream | null = null
let segStartMs = 0
let errorCb: ((msg: string) => void) | null = null
let micEnabled = true

/**
 * Mic preference. Live-mutes/unmutes the current segment's audio track when
 * one exists; if the segment started with mic off (no track captured), the
 * change takes effect from the next manual segment.
 */
export function setDemoMicEnabled(on: boolean) {
  micEnabled = on
  micStream?.getAudioTracks().forEach((t) => { t.enabled = on })
}

export function getDemoMicEnabled(): boolean {
  return micEnabled
}

function pickMime(withAudio: boolean): string {
  const cands = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const MR = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder
  for (const c of cands) if (MR?.isTypeSupported?.(c)) return c
  return 'video/webm'
}

async function startManual(fps: number) {
  const dr = getDR()
  if (!dr) return
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false })
  } catch {
    errorCb?.('Manual video needs macOS Screen-Recording permission (System Settings → Privacy). Timelapse still records.')
    dr.manualStopped({ error: 'permission-or-cancelled' })
    return
  }

  // Narration mic — best-effort: a denied/missing mic must never block video.
  micStream = null
  if (micEnabled) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch {
      errorCb?.('Mic unavailable (permission denied?) — recording video without narration.')
    }
  }

  const tracks = [...stream.getVideoTracks(), ...(micStream?.getAudioTracks() ?? [])]
  const combined = new MediaStream(tracks)
  const hasAudio = !!micStream
  const mime = pickMime(hasAudio)
  try {
    recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
  } catch {
    recorder = new MediaRecorder(combined)
  }
  segStartMs = Date.now()
  recorder.ondataavailable = async (e: BlobEvent) => {
    if (e.data && e.data.size > 0) {
      try { dr.sendVideoChunk(await e.data.arrayBuffer()) } catch { /* main gone */ }
    }
  }
  recorder.onstop = () => {
    const durationMs = Date.now() - segStartMs
    stream?.getTracks().forEach((t) => t.stop())
    micStream?.getTracks().forEach((t) => t.stop())
    stream = null
    micStream = null
    recorder = null
    dr.manualStopped({ durationMs, mime, audio: hasAudio })
  }
  // If the user revokes the OS share, the track ends → stop the segment.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => stopManual())
  recorder.start(1000) // 1s timeslice → steady chunk stream
}

function stopManual() {
  const dr = getDR()
  try {
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    else dr?.manualStopped({})
  } catch {
    dr?.manualStopped({})
  }
}

/**
 * Wire the renderer to main's manual-video commands. Idempotent — safe to call
 * on every mount; the underlying subscription is installed once so manual
 * recording survives hub page navigation.
 */
export function initDemoRecordingClient(opts?: { onError?: (msg: string) => void }) {
  errorCb = opts?.onError ?? errorCb
  const dr = getDR()
  if (!dr || initialized) return
  initialized = true
  dr.onCommand((cmd) => {
    if (cmd.action === 'start-manual') void startManual(cmd.fps || 30)
    else if (cmd.action === 'stop-manual') stopManual()
    else if (cmd.action === 'pause-manual') { try { recorder?.pause() } catch { /* noop */ } }
    else if (cmd.action === 'resume-manual') { try { recorder?.resume() } catch { /* noop */ } }
  })
}

export function demoRecorderAvailable(): boolean {
  return !!getDR()?.available
}
