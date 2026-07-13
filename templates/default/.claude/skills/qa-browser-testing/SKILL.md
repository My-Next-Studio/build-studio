---
name: qa-browser-testing
description: Browser-based QA testing using playwright-cli. Visual verification, state checking, and E2E validation for web applications.
trigger: explicit
---

# QA Browser Testing

Browser testing for QA validation using `playwright-cli`. Use this when you need to
verify visual state, check UI behavior, or validate acceptance criteria that require
a running browser.

## When to use browser testing

```
AC requires verification → Can it be tested with unit tests?
    ├─ Yes (API response, data transform, validation logic) → Write unit test. STOP.
    └─ No (requires browser) → Does it need visual verification?
        ├─ Yes (layout, colors, design match) → Screenshot with playwright-cli
        └─ No (click flow, form submit, navigation) → Interact with playwright-cli
```

**Default to unit tests.** Only use browser testing when the acceptance criterion
genuinely requires a browser — visual state, client-side navigation, form interactions,
or cross-layer integration that can't be tested at the API level.

## playwright-cli quick reference

```bash
# Open and navigate
playwright-cli open http://localhost:<port>
playwright-cli goto http://localhost:<port>/other-page

# Viewport control
playwright-cli resize 1440 900          # desktop
playwright-cli resize 390 844           # mobile

# Screenshots
playwright-cli screenshot --filename /tmp/page.png
playwright-cli screenshot --filename /tmp/full.png --full-page
playwright-cli screenshot "button.submit" --filename /tmp/button.png  # element

# Interact
playwright-cli click "Submit"           # click by text/ref
playwright-cli fill "Email" "test@example.com"
playwright-cli select "Country" "Sweden"
playwright-cli type "Hello world"       # type into focused element
playwright-cli hover "Menu item"

# Inspect
playwright-cli snapshot                 # get page accessibility tree
playwright-cli snapshot "form"          # scoped to element
playwright-cli eval "document.title"    # run JS

# Session management
playwright-cli -s=mobile open http://localhost:<port>  # named session
playwright-cli list                     # list sessions
playwright-cli close                    # close current
playwright-cli close-all               # close all sessions
```

## Verification patterns

### Visual AC verification
```bash
# Screenshot the page at the required viewport
playwright-cli open http://localhost:5173/preview
playwright-cli resize 1440 900
playwright-cli screenshot --filename /tmp/desktop.png --full-page

# Check mobile too if AC requires it
playwright-cli resize 390 844
playwright-cli screenshot --filename /tmp/mobile.png --full-page
playwright-cli close
```

Report: attach screenshot path and describe what you verified visually.

### State verification (error, empty, loading)
```bash
playwright-cli open http://localhost:5173/page
# Trigger error state
playwright-cli click "Submit"  # without filling required fields
playwright-cli screenshot --filename /tmp/error-state.png

# Verify empty state
playwright-cli goto http://localhost:5173/empty-list
playwright-cli screenshot --filename /tmp/empty-state.png
playwright-cli close
```

### Form flow verification
```bash
playwright-cli open http://localhost:5173/form
playwright-cli fill "Name" "Test User"
playwright-cli fill "Email" "test@example.com"
playwright-cli click "Submit"
# Verify success state
playwright-cli snapshot  # check for success message in accessibility tree
playwright-cli screenshot --filename /tmp/form-success.png
playwright-cli close
```

### Design comparison (with Pencil design)
```bash
# 1. Export design from Pencil MCP (done by frontend dev, file should exist)
# 2. Screenshot implementation
playwright-cli open http://localhost:5173/page
playwright-cli resize 1440 900
playwright-cli screenshot --filename /tmp/impl.png --full-page
playwright-cli close

# 3. Run heatmap diff (see docs/wow/web-design-workflow.md)
python3 -c "
from PIL import Image; import numpy as np
d = np.array(Image.open('/tmp/design.png').convert('RGB'), dtype=np.float32)
i = np.array(Image.open('/tmp/impl.png').convert('RGB'), dtype=np.float32)
if d.shape != i.shape: i = np.array(Image.open('/tmp/impl.png').convert('RGB').resize((d.shape[1],d.shape[0]), Image.LANCZOS), dtype=np.float32)
diff = np.sqrt(np.sum((d - i) ** 2, axis=2))
h, w = diff.shape
print('Match % per 3x3 grid:')
for r in range(3):
    for c in range(3):
        s = diff[r*h//3:(r+1)*h//3, c*w//3:(c+1)*w//3]
        print(f'  {np.mean(s < 30) * 100:.1f}%', end='')
    print()
print(f'Overall: {np.mean(diff < 30) * 100:.1f}%')
"
```

## Golden rules

1. **No `waitForTimeout` / `sleep`** — use `playwright-cli snapshot` to check if content
   has loaded. If an element isn't there yet, re-check the snapshot, don't sleep.

2. **Use semantic targets** — click by visible text or ARIA role, not CSS selectors.
   `playwright-cli click "Submit"` not `playwright-cli click ".btn-primary"`.

3. **One thing per verification** — don't try to verify 10 ACs in one browser session.
   Screenshot, close, report. Open fresh for the next check.

4. **Screenshots are evidence** — every visual AC claim should have a screenshot path
   in your feedback. "Looks correct" without a screenshot is not verifiable.

5. **Close the browser** — always `playwright-cli close` when done. Zombie browsers
   consume memory and ports.

6. **Don't write Python scripts** — `playwright-cli` handles browser automation directly.
   Only fall back to Python Playwright for complex multi-step scenarios that can't be
   expressed as sequential CLI commands.

## Anti-patterns

| Don't | Why | Do instead |
|-------|-----|------------|
| Run full E2E suite for unit-testable ACs | Wastes 20+ minutes, flaky | Write unit tests |
| `sleep 5` between commands | Burns tokens, unreliable | Check `snapshot` for readiness |
| Background test + poll loop | Context window killer | Run tests in foreground |
| Screenshot without reporting path | Unverifiable claim | Include `/tmp/filename.png` in feedback |
| Leave browser open between checks | Memory leak, port conflicts | `close` after each verification |
| Use CSS selectors for clicks | Brittle, breaks on refactor | Use visible text or ARIA labels |
