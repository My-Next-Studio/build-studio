const { test } = require('node:test');
const assert = require('node:assert');
const {
  defaultAllowedOrigins,
  parseAllowedOrigins,
  isAllowedOrigin,
} = require('./allowed-origins');

const ALLOW = defaultAllowedOrigins();

test('hub origin is allowed under both spellings of loopback', () => {
  assert.strictEqual(isAllowedOrigin('http://localhost:18080', ALLOW), true);
  assert.strictEqual(isAllowedOrigin('http://127.0.0.1:18080', ALLOW), true);
});

test('an arbitrary website is rejected', () => {
  assert.strictEqual(isAllowedOrigin('https://evil.example', ALLOW), false);
});

test('a different localhost port is rejected', () => {
  // A page served from any other local port is still a different origin, and
  // "it is on localhost" is not evidence that it is the hub.
  assert.strictEqual(isAllowedOrigin('http://localhost:3000', ALLOW), false);
});

test('https on the hub port is rejected', () => {
  // Scheme is part of the origin; the hub is served over http.
  assert.strictEqual(isAllowedOrigin('https://localhost:18080', ALLOW), false);
});

test('a prefix of an allowed origin is rejected', () => {
  // Guards against ever reverting this to a startsWith check.
  assert.strictEqual(isAllowedOrigin('http://localhost:18080.evil.example', ALLOW), false);
});

test('missing origin is allowed — non-browser clients are not the exposure', () => {
  assert.strictEqual(isAllowedOrigin(undefined, ALLOW), true);
  assert.strictEqual(isAllowedOrigin('', ALLOW), true);
});

test("the string 'null' is rejected, unlike a missing origin", () => {
  // Sandboxed iframes and file:// pages send Origin: null, and an attacker can
  // arrange that — it must not be treated as "no browser involved".
  assert.strictEqual(isAllowedOrigin('null', ALLOW), false);
});

test('BUILD_STUDIO_ALLOWED_ORIGINS overrides the default list', () => {
  const list = parseAllowedOrigins('http://localhost:4000,https://studio.example');
  assert.deepStrictEqual(list, ['http://localhost:4000', 'https://studio.example']);
  assert.strictEqual(isAllowedOrigin('https://studio.example', list), true);
  // An explicit list replaces the defaults rather than extending them.
  assert.strictEqual(isAllowedOrigin('http://localhost:18080', list), false);
});

test('override tolerates whitespace and trailing commas', () => {
  const list = parseAllowedOrigins(' http://a.example , http://b.example ,');
  assert.deepStrictEqual(list, ['http://a.example', 'http://b.example']);
});

test('unset or blank override falls back to the hub defaults', () => {
  assert.deepStrictEqual(parseAllowedOrigins(undefined), ALLOW);
  assert.deepStrictEqual(parseAllowedOrigins(''), ALLOW);
  assert.deepStrictEqual(parseAllowedOrigins('   '), ALLOW);
  assert.deepStrictEqual(parseAllowedOrigins(' , , '), ALLOW);
});

test('a wildcard in the override is treated as a literal, never as "any"', () => {
  // If someone puts '*' in the env var expecting the old behaviour, it must
  // fail closed rather than silently restoring the hole this replaced.
  const list = parseAllowedOrigins('*');
  assert.strictEqual(isAllowedOrigin('https://evil.example', list), false);
});

// ── the origin guard on writes (security review, 2026-10-06) ───────────────
// A plain-text form post from a foreign page needs no preflight, so CORS never
// sees it: it reached POST /draft/create-story with an empty body and started
// an agent session. The guard refuses any state-changing request from a
// disallowed origin, before any route runs.
{
  const express = require('express');
  const http = require('http');
  const { corsMiddleware } = require('./allowed-origins');

  async function send(method, headers = {}, body) {
    const app = express();
    app.use(express.json());
    app.use(corsMiddleware(ALLOW));
    let ran = false;
    app.all('/api/thing', (req, res) => { ran = true; res.json({ ok: true }); });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/thing`, { method, headers, body });
      return { status: res.status, ran, acao: res.headers.get('access-control-allow-origin') };
    } finally {
      server.close();
    }
  }

  test('a cross-site text/plain POST is refused before the route runs', async () => {
    const r = await send('POST', { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, 'x');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.ran, false);
    assert.strictEqual(r.acao, null);
  });

  test('every state-changing method is guarded, and the null origin counts as foreign', async () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.strictEqual((await send(m, { Origin: 'https://evil.example' })).ran, false, m);
    }
    assert.strictEqual((await send('POST', { Origin: 'null' })).status, 403);
  });

  test('the hub, curl-style callers and plain reads are unaffected', async () => {
    const hub = await send('POST', { Origin: 'http://localhost:18080', 'Content-Type': 'application/json' }, '{}');
    assert.strictEqual(hub.status, 200);
    assert.strictEqual(hub.acao, 'http://localhost:18080');
    assert.strictEqual((await send('POST', { 'Content-Type': 'application/json' }, '{}')).status, 200, 'no Origin: agents, curl');
    const read = await send('GET', { Origin: 'https://evil.example' });
    assert.strictEqual(read.ran, true, 'reads are left to CORS, which withholds the response');
    assert.strictEqual(read.acao, null);
  });

  test('a foreign preflight still gets a bare 204', async () => {
    const r = await send('OPTIONS', { Origin: 'https://evil.example' });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.acao, null);
  });
}

// ── DNS rebinding (security review, 2026-10-06) ────────────────────────────
// A page whose own name is re-pointed at 127.0.0.1 talks to this server as
// same-origin, so a GET carries no Origin and passed as a non-browser client.
// The Host header still carries the attacker's name, and that is what is checked.
{
  const express = require('express');
  const http = require('http');
  const { corsMiddleware, isAllowedHost, allowedHostnames } = require('./allowed-origins');

  async function rawGet(host, origins = ALLOW) {
    const app = express();
    app.use(corsMiddleware(origins));
    let ran = false;
    app.get('/api/thing', (req, res) => { ran = true; res.json({ secret: 1 }); });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const status = await new Promise((resolve, reject) => {
        const headers = host === undefined ? {} : { Host: host };
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/thing', headers, setHost: host !== undefined ? false : true }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.end();
      });
      return { status, ran };
    } finally {
      server.close();
    }
  }

  test('a rebound read, addressed to a foreign name, is refused before any route runs', async () => {
    const r = await rawGet('attacker.example:3005');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.ran, false);
  });

  test('loopback under every spelling, on any port, is served', async () => {
    for (const h of ['localhost:3005', '127.0.0.1:3010', '[::1]:3005', 'LOCALHOST:3005', 'localhost']) {
      assert.strictEqual((await rawGet(h)).status, 200, h);
    }
  });

  test('a deliberately allowed origin brings its host with it', async () => {
    const widened = [...ALLOW, 'http://studio.lan:18080'];
    assert.strictEqual((await rawGet('studio.lan:3005', widened)).status, 200);
    assert.strictEqual((await rawGet('studio.lan:3005')).status, 403, 'not without the setting');
  });

  test('host parsing: a missing header is a non-browser client; look-alikes are not loopback', () => {
    const names = allowedHostnames(ALLOW, undefined);
    assert.strictEqual(isAllowedHost(undefined, names), true);
    assert.strictEqual(isAllowedHost('localhost.attacker.example', names), false);
    assert.strictEqual(isAllowedHost('127.0.0.1.nip.io:3005', names), false);
    assert.strictEqual(isAllowedHost('[::1]', names), true);
    assert.strictEqual(allowedHostnames(ALLOW, '0.0.0.0').has('0.0.0.0'), false, 'a wildcard bind is not a hostname');
    assert.strictEqual(allowedHostnames(ALLOW, '192.168.1.20').has('192.168.1.20'), true);
  });
}
