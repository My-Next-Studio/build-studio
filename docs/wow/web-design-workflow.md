# Web Design Workflow

## Overview

There are two ways to drive visual design for web projects. Pick one per project — or mix them, using Option B for the pages where composition matters most.

- **Option A — Claude-designed design system (default).** Claude creates a design system directly in code; features are implemented against it. No external design tool required. This is the most common path.
- **Option B — Pencil design-first (per-page mockups).** Pages are designed as `.pen` mockups in Pencil.dev before implementation, and the implementation is verified against the design with screenshot diffs. Best for marketing/landing pages and other high-stakes visuals.

The workflow engine follows suit automatically: when a PRD has `.pen` design files, implementation agents get mandatory design-match instructions (read the design first, verify with a heatmap diff). When it doesn't, agents implement against the project's design system.

---

## Option A — Claude-designed design system (default)

### 1. Create the design system

Use the `frontend-design` skill via Claude Code to establish the system once, early in the project:

- Design tokens as CSS variables (colors, typography scale, spacing, radii, shadows)
- Base components (buttons, inputs, cards, navigation, tables) with their states
- A distinctive direction — the skill is good at avoiding generic-AI aesthetics; give it the brand inputs you have

### 2. Make the system the reference

Capture it where agents will find it: the token file (e.g. `globals.css`), the component library, and a short `docs/design-system.md` describing the direction, dos/don'ts, and any signature elements. Optionally add a style-guide page (`/styleguide`) that renders every token and component — it doubles as a visual regression surface.

### 3. Implement features against the system

The `frontend_dev` role builds new pages and components from existing tokens and components — matching what's already there rather than inventing per-page styles. New component variants extend the system deliberately, not ad hoc.

### 4. Verify in the browser

No pixel-diff against a mockup — verification is consistency and quality:

- Screenshot key pages/states with `playwright-cli` at desktop (1440×900) and mobile (390×844)
- Check tokens are used (no hardcoded one-off colors/spacing), states exist (hover, error, empty, loading), and mobile actually works
- The human pass happens at demo review; QA attaches screenshots as evidence

---

## Option B — Pencil design-first (per-page mockups)

Requires the Pencil.dev app + its MCP. `.pen` files are created and iterated **interactively** (a human driving the designer role in the Pencil app) — automated workflow agents read `.pen` files but never author them.

### 1. Design in Pencil (first draft)

Use the `frontend-design` skill via Claude Code to create the initial design in a `.pen` file using the Pencil MCP tools. The skill produces much better visual design than coding directly.

```
/frontend-design — creates initial design in Pencil
```

The first draft should include:
- Desktop layout (1440px wide)
- Mobile layout (390×844, iPhone 14/15)
- All major sections and states

### 2. Iterate in Pencil

Open the `.pen` file in the Pencil app and iterate directly in its chat interface. Visual tweaks are faster in Pencil than in code. Continue until the design is approved.

### 3. Implement in code

The `frontend_dev` role implements the approved Pencil design faithfully. The role command enforces design-first:
- Read the design spec and `.pen` file before writing any component
- Implement the approved design, don't design on the fly
- When no design exists, flag the gap rather than improvising

### 4. Verify with screenshot comparison

Use `playwright-cli` (`@playwright/cli`) to screenshot the implementation and compare against the Pencil design export using a Python diff script.

**Setup requirements:**
```bash
npm install -g @playwright/cli
pip install Pillow --break-system-packages
```

**Process:**
1. Export the Pencil frame as PNG (2x scale) via `export_nodes` MCP tool → `/tmp/design.png`
2. Screenshot the implementation with `playwright-cli`:
   ```bash
   playwright-cli open http://localhost:<port>/<path>
   playwright-cli resize 1440 900
   playwright-cli screenshot --filename /tmp/impl.png --full-page
   playwright-cli close
   ```
3. Run the diff script to generate a heatmap and match percentages per 3x3 grid
4. Fix the top discrepancies and re-run until match is >85%

**Diff script pattern:**
```python
from PIL import Image
import numpy as np

design = Image.open('/tmp/design.png').convert('RGB')
impl = Image.open('/tmp/impl.png').convert('RGB')

# Resize to match
if design.size != impl.size:
    impl = impl.resize(design.size, Image.LANCZOS)

d = np.array(design, dtype=np.float32)
i = np.array(impl, dtype=np.float32)
diff = np.sqrt(np.sum((d - i) ** 2, axis=2))

# Heatmap: black = identical, red = different
heatmap = np.zeros((*diff.shape, 3), dtype=np.uint8)
heatmap[:, :, 0] = (diff / np.sqrt(3 * 255**2) * 255).astype(np.uint8)
Image.fromarray(heatmap).save('/tmp/diff.png')

# Match % per 3x3 grid
h, w = diff.shape
for r in range(3):
    for c in range(3):
        section = diff[r*h//3:(r+1)*h//3, c*w//3:(c+1)*w//3]
        print(f"  {np.mean(section < 30) * 100:.1f}%", end="")
    print()
```

**playwright-cli quick reference:**
```bash
playwright-cli open <url>                  # open browser
playwright-cli resize <w> <h>              # set viewport
playwright-cli screenshot --filename <f>   # capture page
playwright-cli screenshot --full-page      # full scrollable page
playwright-cli goto <url>                  # navigate
playwright-cli close                       # close browser
```

**Tips:**
- Compare section-by-section for long pages (full-page height mismatches distort the diff)
- For mobile, use viewport 390×844
- For desktop, use viewport 1440×900
- Export Pencil frames at 2x scale for comparison
- Use `playwright-cli -s=<name>` to manage multiple sessions if needed

### 5. Mobile-specific designs

Mobile layouts often need completely different HTML, not just CSS responsive overrides:
- Use `.mobile-*` class blocks hidden on desktop (`display: none`)
- Hide desktop blocks on mobile
- Mobile sections may have different content (fewer cards, simpler layouts)
- Always design mobile separately in Pencil — don't assume desktop responsiveness is enough

---

## Choosing between the options

| | Option A — design system | Option B — Pencil mockups |
|---|---|---|
| Best for | Product UI, dashboards, apps — most day-to-day work | Marketing sites, landing pages, high-stakes visuals |
| Source of truth | Tokens + components + `docs/design-system.md` | The `.pen` file |
| Verification | Consistency checks + browser screenshots + demo review | Heatmap diff vs design export, >85% match |
| Tooling | Claude Code only | Pencil.dev app + MCP + playwright-cli |
| Iteration | In code | In the Pencil app (interactive) |

## Key Principles

- **One source of truth per page.** With a design system, the system wins over per-page improvisation; with a Pencil design, the `.pen` file wins over the code.
- **Agents implement, they don't improvise design.** When neither a design system nor a design exists for new UI, flag the gap rather than inventing styles mid-implementation.
- **The `frontend-design` skill** is for creating designs and design systems, not for implementation aesthetics. The developer role uses it for CSS techniques only.
- **Feedback screenshots** can be dropped in a `/feedback` folder for comparison.
- **Full-bleed photo overlays** can cause content cutoff issues in fixed-height frames. Prefer photo-on-top layouts or centered overlay text for reliability.
