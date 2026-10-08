#!/usr/bin/env node
// Keeps the two files every agent reads first short and true (Build Studio's
// docs budget). Exits non-zero when:
//   - docs/project-state.md is over 40 KiB, or ARCHITECTURE.md (when the repo
//     has one) over 20 KiB — Build Studio's warning limits;
//   - docs/project-state.md is missing;
//   - a backtick path in ARCHITECTURE.md that names a repo file or directory
//     doesn't exist.
// Revise these files rather than append to them: history goes to
// docs/history/, decisions to docs/decisions.md.
//
// A backtick token is checked as a repo path unless one of these rules skips
// it, so a stale source or doc path is still caught:
//   - no `/`, or contains whitespace: a symbol, flag or command
//   - starts with `~`, `$`, `-`, `@` or a URL scheme: runtime, env, flag, alias, link
//   - contains `*`, `<`, `>`, `{`, `[`, `|`, `…` or `...`: a glob, placeholder, route or abbreviation
//   - starts with build output (`dist/`, `build/`, `out/`, `.svelte-kit/`, `coverage/`)
//   - first segment is not a top-level repo entry: a path relative to a module
//     named nearby, or a URL path such as `/api/health`
//
// Usage: node scripts/check-docs-budget.mjs [repo root]
//        node scripts/check-docs-budget.mjs --self-test

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = [
  ["docs/project-state.md", 40 * 1024, true],
  ["ARCHITECTURE.md", 20 * 1024, false],
];
const BUILD_OUTPUT = /^(dist|build|out|\.svelte-kit|coverage)\//;

function repoPathTokens(markdown, root) {
  const topLevel = new Set(readdirSync(root));
  return [...markdown.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1])
    .filter((t) => {
      if (!t.includes("/") || /\s/.test(t)) return false;
      if (/^(~|\$|-|@|[a-z][a-z0-9+.-]*:)/i.test(t)) return false;
      if (/[*<>{[|…]|\.\.\./.test(t)) return false;
      if (BUILD_OUTPUT.test(t)) return false;
      return topLevel.has(t.split("/")[0]);
    });
}

function checkDocs(root) {
  const failures = [];
  for (const [rel, limit, required] of LIMITS) {
    const file = path.join(root, rel);
    if (!existsSync(file)) {
      if (required) failures.push(`${rel} is missing`);
      continue;
    }
    const bytes = statSync(file).size;
    if (bytes > limit) {
      failures.push(`${rel} is ${bytes} bytes, over its ${limit}-byte (${limit / 1024} KB) limit: revise it, move history to docs/history/`);
    }
  }
  const arch = path.join(root, "ARCHITECTURE.md");
  if (existsSync(arch)) {
    for (const token of repoPathTokens(readFileSync(arch, "utf8"), root)) {
      if (!existsSync(path.join(root, token))) failures.push(`ARCHITECTURE.md names \`${token}\`, which does not exist`);
    }
  }
  return failures;
}

function selfTest() {
  const KB = 1024;
  const cases = [
    ["a valid pair passes", {}, []],
    ["project-state.md at 40 KB passes", { "docs/project-state.md": "x".repeat(40 * KB) }, []],
    ["project-state.md one byte over fails", { "docs/project-state.md": "x".repeat(40 * KB + 1) }, [/^docs\/project-state\.md is 40961 bytes/]],
    ["ARCHITECTURE.md at 20 KB passes", { "ARCHITECTURE.md": "x".repeat(20 * KB) }, []],
    ["ARCHITECTURE.md one byte over fails", { "ARCHITECTURE.md": "x".repeat(20 * KB + 1) }, [/^ARCHITECTURE\.md is 20481 bytes/]],
    ["a missing project-state.md fails", { "docs/project-state.md": null }, [/^docs\/project-state\.md is missing$/]],
    ["no ARCHITECTURE.md is allowed", { "ARCHITECTURE.md": null }, []],
    ["a stale repo path fails", { "ARCHITECTURE.md": "`src/gone.ts`" }, [/names `src\/gone\.ts`/]],
    [
      "the skip rules leave only repo paths checked",
      { "ARCHITECTURE.md": "`src/app.ts` `lib/relative.ts` `/api/health` `dist/index.js` `src/**/*.ts` `src/routes/[slug]` `docs/prds/PRD-NNN-<name>.md` `https://example.com/x` `--flag` `RhythmEngine`" },
      [],
    ],
  ];
  let failed = 0;
  for (const [name, files, expected] of cases) {
    const root = mkdtempSync(path.join(os.tmpdir(), "docs-budget-"));
    try {
      const all = { "docs/project-state.md": "# State\n", "ARCHITECTURE.md": "# Map\n", "src/app.ts": "", ...files };
      for (const [rel, content] of Object.entries(all)) {
        if (content === null) continue;
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
      }
      const got = checkDocs(root);
      const ok = got.length === expected.length && expected.every((re, i) => re.test(got[i]));
      console[ok ? "log" : "error"](`${ok ? "✓" : "✗"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}`}`);
      if (!ok) failed += 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return failed;
}

if (process.argv[2] === "--self-test") {
  process.exit(selfTest() === 0 ? 0 : 1);
}
const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const failures = checkDocs(root);
if (failures.length > 0) {
  console.error(["docs budget: FAILED", ...failures.map((f) => `  ${f}`)].join("\n"));
  process.exit(1);
}
console.log("docs budget: OK — project-state.md and ARCHITECTURE.md within limits, ARCHITECTURE.md paths exist");
