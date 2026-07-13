# Build Studio

Multi-project mission control for Claude Code agent workflows. Monorepo with
three packages: hub (Next.js frontend), project-server (Express API per project),
and desktop (Electron shell).

## Architecture

```
packages/
  hub/           — Next.js 16 frontend (React 19, Turbopack)
  project-server/ — Express + WebSocket server, one instance per managed project
  desktop/       — Electron app, bundles hub + project-server
  shared/        — Shared utilities (process-manager, etc.)
```

The Electron app runs a bundled Next.js standalone build. Each managed project
gets its own project-server instance on a dedicated port.

## Build & Deploy (Electron App)

**IMPORTANT — user runs the Electron app, not `npm run dev`.** Any change to
`packages/hub/` or `packages/project-server/` is invisible to the user until
the bundle is rebuilt and the Electron app is relaunched. After editing
dashboard code, run the relevant rebuild command below before reporting the
work as done.

Changes to hub components or project-server code require specific steps
depending on what changed.

### Project-server only (API changes)

The `--sync-only` flag copies `packages/project-server/` and `packages/shared/`
into the Electron `.app` bundle but does NOT update the Next.js build:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the Electron app. Running project-servers also need restart
(stop/start from the hub, or restart the Electron app).

### Hub frontend changes (components, lib, styles)

Hub changes require a Next.js rebuild AND full inject:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Then restart the Electron app. The full inject (without `--sync-only`):
1. Copies the standalone build output into the `.app`
2. Copies static assets
3. Copies public assets (avatars etc.)
4. Injects `@build-studio/*` packages into standalone node_modules
5. Clears Electron browser cache

### Both hub + project-server changes

Same as hub changes — the full inject also syncs project-server.

### Dev mode (no Electron)

```bash
cd packages/hub && npm run dev          # Hub on :18080 (Turbopack, hot reload)
cd packages/project-server && node index.js /path/to/project  # Direct server
```

## Key Patterns

### Adding a tab to a function (Project/Development/Operations)

1. Define the tab key in `packages/hub/lib/functions.ts` — add to the
   function's `tabs` array
2. Create the tab component in `packages/hub/components/<name>-tab.tsx`
3. Register in `packages/hub/components/project-dashboard.tsx`:
   - Import the component
   - Add `{ key, label }` to the `allTabs` array
   - Add render line: `{tab === 'key' && <Component />}`
4. If the tab needs API data, add a route in `packages/project-server/lib/api/`
   and mount it in `packages/project-server/lib/server.js`

### Adding an API endpoint

1. Create router in `packages/project-server/lib/api/<name>.js`
   - Follow pattern: `function createXRouter(config) { ... }; module.exports = { createXRouter }`
   - `config.projectRoot` = managed project root, `config.docsPath` = its docs dir
2. Import and mount in `packages/project-server/lib/server.js`
3. Rebuild + inject into Electron (see above)

### Styling conventions

- Inline styles (no CSS modules), using CSS variables: `var(--mono)`, `var(--text)`,
  `var(--muted)`, `var(--surface)`, `var(--border)`, `var(--accent)`, `var(--green)`,
  `var(--red)`, `var(--orange)`
- Mono font for all UI text: `fontFamily: 'var(--mono)'`
- Section headers: `fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.1em', color: 'var(--text-dim)'`
- Markdown rendering: `ReactMarkdown` + `remarkGfm`, wrapped in `className="md-rendered"`

## Finding running project-servers

Project-servers run on configured ports. To find them:

```bash
# Check a specific port
curl -s http://localhost:<port>/api/health

# Scan common ports
for p in 3000 3001 3002 3003 3500; do
  curl -s "http://localhost:$p/api/health" 2>/dev/null
done
```

The health endpoint returns `{ ok, name, projectRoot, uptime, startedAt }`.
