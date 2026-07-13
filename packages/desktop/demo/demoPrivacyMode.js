// Demo Recording — privacy mode.
//
// Two independent safeguards, both decided with the owner:
//
//   1. Privacy Pause — a hard toggle. While paused, demoRecorder.js writes no
//      frames (manual video is paused in the renderer, the timelapse loop skips
//      ticks) and the manifest records the gap. Nothing sensitive can leak
//      because nothing is captured.
//
//   2. Auto-blur — best-effort heuristic redaction. We inject a stylesheet +
//      a MutationObserver scanner into the page that tags elements whose text
//      matches secret/PII patterns (API keys, .env lines, bearer tokens, home
//      paths, emails) plus always-sensitive inputs (type=password). Tagged
//      elements get a real CSS blur, so they are blurred in BOTH the manual
//      video (MediaRecorder paints the DOM) and the timelapse (capturePage
//      reads the same surface). The owner reviews before publishing, so
//      best-effort coverage is acceptable — this is defence in depth, not a
//      guarantee.
//
// This module only manipulates the page via the passed-in webContents. The
// pause STATE lives here; demoRecorder.js reads isPaused() each tick.

const REDACT_ATTR = 'data-demo-redact';

// Injected once into the page. Kept as a string so it can be handed to
// webContents.executeJavaScript. Idempotent: re-running re-uses the same
// observer via a window-scoped guard.
function scannerSource(redactAttr) {
  return `(() => {
    const ATTR = ${JSON.stringify(redactAttr)};
    if (window.__demoRedactScanner) { window.__demoRedactScanner.start(); return 'already'; }

    // Heuristic secret / PII patterns. Intentionally broad — false positives
    // (an over-blurred token-shaped string) are harmless for a demo; misses are
    // the cost we accept and the owner backstops with a manual review.
    const PATTERNS = [
      /sk-ant-[A-Za-z0-9_-]{8,}/,            // Anthropic keys
      /sk-[A-Za-z0-9]{20,}/,                 // OpenAI-style keys
      /gh[pousr]_[A-Za-z0-9]{16,}/,          // GitHub tokens
      /xox[baprs]-[A-Za-z0-9-]{8,}/,         // Slack tokens
      /AKIA[0-9A-Z]{12,}/,                   // AWS access key id
      /\\bBearer\\s+[A-Za-z0-9._-]{12,}/,    // bearer tokens
      /\\beyJ[A-Za-z0-9._-]{20,}/,           // JWTs
      /[A-Za-z0-9+/]{40,}={0,2}/,            // long base64 blobs
      /\\b[0-9a-f]{40,}\\b/,                 // long hex (sha/secrets)
      /^[A-Z][A-Z0-9_]{2,}=\\S+/m,           // .env style KEY=value
      /\\/Users\\/[^/\\s]+/,                  // macOS home paths (username)
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/, // emails
    ];

    function looksSensitive(text) {
      if (!text || text.length < 6 || text.length > 4000) return false;
      return PATTERNS.some((re) => re.test(text));
    }

    // Only scan leaf-ish elements so we blur the tightest box around the
    // secret, not a whole panel. We walk elements that directly contain text.
    function scan() {
      try {
        // Always blur password fields + anything the app explicitly tags.
        document.querySelectorAll('input[type=password], [data-sensitive], [data-demo-sensitive]')
          .forEach((el) => el.setAttribute(ATTR, ''));

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
          acceptNode(el) {
            if (el.closest('[' + ATTR + ']')) return NodeFilter.FILTER_REJECT;
            // element with mostly direct text content
            const direct = Array.from(el.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent).join('');
            return looksSensitive(direct) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          },
        });
        let n; let guard = 0;
        while ((n = walker.nextNode()) && guard++ < 500) n.setAttribute(ATTR, '');
      } catch (_) { /* page mid-render — try again next tick */ }
    }

    let timer = null; let observer = null; let running = false;
    const api = {
      start() {
        if (running) return; running = true;
        scan();
        observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 400); });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        api._interval = setInterval(scan, 1500); // catch canvas/virtualized updates
      },
      stop() {
        running = false;
        if (observer) observer.disconnect();
        clearTimeout(timer); clearInterval(api._interval);
        document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
      },
    };
    window.__demoRedactScanner = api;
    api.start();
    return 'installed';
  })();`;
}

class DemoPrivacyMode {
  constructor(webContents) {
    this.wc = webContents;
    this._paused = false;
    this._blur = false;
    this._cssKey = null;
  }

  isPaused() { return this._paused; }
  isBlurEnabled() { return this._blur; }

  pause() { this._paused = true; }
  resume() { this._paused = false; }

  async enableBlur() {
    if (this._blur || !this.wc) return;
    this._blur = true;
    try {
      this._cssKey = await this.wc.insertCSS(
        `[${REDACT_ATTR}]{ filter: blur(9px) !important; transition: none !important; }`
      );
      await this.wc.executeJavaScript(scannerSource(REDACT_ATTR), true);
    } catch (e) {
      // Non-fatal: capture still proceeds, just without auto-blur.
      this._blur = false;
      console.error('[demo] enableBlur failed:', e.message);
    }
  }

  async disableBlur() {
    if (!this._blur || !this.wc) return;
    this._blur = false;
    try {
      await this.wc.executeJavaScript('window.__demoRedactScanner && window.__demoRedactScanner.stop();', true);
      if (this._cssKey) { await this.wc.removeInsertedCSS(this._cssKey); this._cssKey = null; }
    } catch (e) {
      console.error('[demo] disableBlur failed:', e.message);
    }
  }

  async dispose() {
    await this.disableBlur().catch(() => {});
  }
}

module.exports = { DemoPrivacyMode, REDACT_ATTR };
