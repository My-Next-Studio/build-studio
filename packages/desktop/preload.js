// Preload — exposes a minimal, audited `window.demoRecorder` bridge to the hub
// renderer (contextIsolation is ON, nodeIntegration OFF). The renderer never
// touches ipcRenderer directly; it only sees these wrapped functions.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('demoRecorder', {
  available: true,

  // Controls (renderer → main, awaited)
  start: (opts) => ipcRenderer.invoke('demo:start', opts || {}),
  stop: () => ipcRenderer.invoke('demo:stop'),
  getStatus: () => ipcRenderer.invoke('demo:status'),
  setInterval: (sec) => ipcRenderer.invoke('demo:set-interval', sec),
  privacyPause: (on) => ipcRenderer.invoke('demo:privacy-pause', !!on),
  setBlur: (on) => ipcRenderer.invoke('demo:set-blur', !!on),
  mark: (label, meta) => ipcRenderer.invoke('demo:mark', { label, meta: meta || {} }),

  // Manual-video plumbing (renderer owns MediaRecorder; streams chunks to main)
  sendVideoChunk: (arrayBuffer) => ipcRenderer.send('demo:video-chunk', arrayBuffer),
  manualStopped: (meta) => ipcRenderer.send('demo:manual-stopped', meta || {}),

  // External window/screen capture (Phase 2b): pick a source, then getDisplayMedia returns it.
  listCaptureSources: () => ipcRenderer.invoke('demo:list-capture-sources'),
  setCaptureSource: (id) => ipcRenderer.invoke('demo:set-capture-source', id),

  // main → renderer
  onCommand: (cb) => subscribe('demo:command', cb), // {action:'start-manual'|'stop-manual'|'pause-manual'|'resume-manual', ...}
  onState: (cb) => subscribe('demo:state', cb),
});
