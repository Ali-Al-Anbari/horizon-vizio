---
name: visual-regression-review
description: >-
  Visual regression review and QA verification skill for Horizon TV interfaces.
  Use this skill whenever auditing, comparing, or verifying rendered Horizon screens
  against supplied design reference images (such as Prime Video captures or physical Vizio photos),
  evaluating 1920x1080 TV layouts, inspecting browser console errors, detecting spacing/alignment
  defects, and confirming that UI changes preserve all existing functional tests and behaviors.
---

# Horizon Visual Regression & Quality Review Guide

This skill specifies the visual audit and regression verification procedures for Horizon streaming surfaces. It ensures that UI changes match design reference benchmarks (`Prime(DETAIL).jpeg`, `Prime(Episode).jpeg`, `Horizon Watch Home Screen.png`) at 1920×1080 resolution without regressing functionality or performance on physical Vizio SmartCast hardware.

---

## 1. Visual Reference Benchmarking Workflow

When modifying or auditing any Horizon TV screen, execute this structured review process:

### Step 1: Benchmark Acquisition & Analysis
1. Inspect the supplied reference artifacts:
   - `Prime(DETAIL).jpeg`: Amazon Prime Video detail view with landscape episode thumbnails, season dropdown, and compact metadata.
   - `Prime(Episode).jpeg`: Amazon Prime Video show landing view with primary resume pill and full-bleed cinematic art.
   - `Horizon Watch Home Screen.png`: Approved Watch Home design reference.
   - Physical Vizio captures (e.g. `curr.jpg`): On-device photo captures used to verify real display rendering.
2. Note key visual markers:
   - Backdrop composition and focal point alignment (artwork biased right, scrim biased left).
   - Horizontal and vertical spacing (left margin insets, gap between title and synopsis, gap between action buttons and carousel).
   - Component geometry (16:9 landscape aspect ratio vs 2:3 vertical posters).
   - Focus styling (high-contrast white outline, subtle blue-white aura).

### Step 2: Rendered Capture at 1920×1080
1. Always evaluate at the standard TV resolution: **1920×1080** (Full HD).
2. Capture a high-resolution screenshot using an available browser automation tool (Playwright MCP, headless browser, or local preview).
3. If automated browser tools are unavailable, perform an exact DOM and computed CSS geometry check via unit tests or script verification before declaring completion.

### Step 3: Delta Identification & Prioritization
Catalog any visual discrepancies into three distinct buckets:
- **Structural Defect**: Wrong layout model, missing components, or incorrect aspect ratio (e.g., using vertical poster cards where 16:9 landscape thumbnails are required).
- **Styling / Spacing Discrepancy**: Misaligned padding, harsh gradient seams, incorrect font sizes, or excessive focus aura.
- **Data Difference**: Natural variation in episode count, title length, or progress state. (Never fabricate dummy rows to match mock data counts).

---

## 2. 1920×1080 TV Layout & Alignment Checklist

Verify every rendered view against these 10-foot UI geometric criteria:

| Feature | Specification | Verification Rule |
| :--- | :--- | :--- |
| **TV Safe Margin** | `48px` min inset from all screen edges | Text or interactive elements must never touch outer display borders (overscan protection). |
| **Backdrop Artwork** | `100vw × 100vh` full-bleed | No white letterboxing, harsh cuts, or unshaded visual seams. Right-aligned focal subject. |
| **Left Copy Width** | `max-width: min(54vw, 820px)` | Metadata and synopsis must not extend past the 55% mark of the screen. |
| **Title Typography** | `clamp(32px, 3vw, 52px)`, bold | Easily legible from 10 feet away. |
| **Metadata Typography**| `14px–18px`, high contrast | Rating pills, episode duration, air date, and audio tags clearly distinguishable. |
| **Episode Thumbnails** | Exact `16 / 9` aspect ratio | Landscape orientation with cover fit. No vertical stretching or squishing. |
| **Focus Indicator** | `2px solid #ffffff` + aura | High-contrast outline visible against both dark scrims and bright underlying artwork. |
| **Horizontal Scrolling**| Container overflows cleanly | No unwanted horizontal page scrollbar on the root window or viewport. |

---

## 3. Console & Runtime Health Audit

A visually appealing screen is invalid if it produces hidden JavaScript errors or memory leaks. Verify:

1. **Zero Uncaught Exceptions**:
   - Inspect console logs for runtime errors (`TypeError`, `ReferenceError`, unhandled promise rejections).
2. **Network Asset Integrity**:
   - Ensure all image URLs (`poster`, `backdrop`, `still`) resolve with HTTP 200.
   - Verify that image error listeners (`still.addEventListener("error", ...)`) gracefully fall back to clean text placeholders when TMDB or external CDN assets are missing.
3. **No Memory Leaks / Detached Timers**:
   - Verify that all interval timers (`holdMotion.inactivityTimer`, `wheelFadeTimer`, `searchTimer`) are cleared on navigation and view destruction.

---

## 4. Functional Non-Regression Verification

UI styling updates must never damage existing application logic, focus trees, or persistence schemas.

### Automated Test Execution
Run the full existing Node test suite before and after any visual changes:
```bash
node --test tests/watch-navigation-scroll-history.test.js
node --test tests/watch-phase4c.test.js
node --test tests/universal-search-core.test.js
node --test tests/frontend-performance.test.js
```

### Invariants to Protect
1. **DOM ID Contracts**: Preserve existing IDs used by tests and focus managers (`#details-view`, `#episodes-view`, `#detail-art`, `#detail-copy`, `#detail-actions`, `#episode-list`, `#seasons`).
2. **Storage Key Contracts**: Never modify or corrupt local storage keys:
   - `core.HISTORY_KEY` (`horizon-universal-search-history-v1`)
   - `HERO_PREF_KEY` (`horizon-watch-hero-preferences`)
   - `core.BROWSING_SEASON_KEY`
3. **Remote Navigation Routing**:
   - Confirm ArrowUp/Down/Left/Right steps cleanly through interactive elements without focus traps.
   - Confirm `Back` routes up the view hierarchy without leaving the app unexpectedly.
   - Confirm `Enter` activates the focused item.

---

## 5. Physical Vizio SmartCast Hardware Evaluation

When validating physical captures or testing on real Vizio hardware:

1. **Compositing & Frame Rates**:
   - Ensure no stuttering during carousel scrolling. If frame rates dip, verify that `backdrop-filter: blur` was avoided and only `transform: translate3d` / `opacity` are animated.
2. **Color & Contrast on TV Panels**:
   - Real TV panels have varying black levels and saturation. Check that subtle gradients do not exhibit harsh banding (color posterization) and that text remains readable.
3. **Remote Latency**:
   - Rapid D-pad pressing must not trigger runaway focus or race conditions with image fetching.
