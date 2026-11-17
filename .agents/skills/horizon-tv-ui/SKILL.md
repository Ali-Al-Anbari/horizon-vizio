---
name: horizon-tv-ui
description: >-
  Specialized TV interface design and styling guide for Horizon's streaming frontend.
  Use this skill whenever designing, modifying, or auditing Horizon TV screens,
  including Amazon Prime Video-style show details, cinematic full-bleed backdrops,
  compact left-side metadata, 16:9 landscape episode carousels, season dropdowns,
  minimal unboxed visual styling, and physical Vizio SmartCast display optimizations.
---

# Horizon TV UI Design System & Architecture

This skill provides the architectural and styling specification for Horizon's 10-foot television interface (`universal-search/` and `frontend/`), adhering to modern Amazon Prime Video design standards while respecting the hardware limitations of physical Vizio SmartCast displays.

---

## 1. Prime Video-Style Cinematic TV Philosophy

Horizon's TV interface follows the cinematic Prime Video model demonstrated in `Prime(DETAIL).jpeg` and `Prime(Episode).jpeg`:

1. **Full-Bleed Visual Canvas**: The background artwork is not boxed or letterboxed inside a small preview container. It fills the entire display viewport (1920×1080) with subtle, multi-stage directional gradients.
2. **Minimal Unboxed Layout**: Avoid "cards-inside-cards-inside-cards", heavy rectangular backgrounds, or chunky containers around text. Elements (titles, metadata, synopses) float cleanly over the dark scrim gradient.
3. **Compact Left-Side Hierarchy**: Key decision-making information (series title, season indicator, episode title, synopsis, duration, rating badges, primary actions) is tightly clustered on the left (spanning ~45% to 55% of viewport width), leaving the right half unobstructed for cinematic character imagery.
4. **16:9 Landscape Episode Carousels**: Television episodes are represented with horizontal landscape stills (16:9 aspect ratio), never vertical 2:3 posters. Episode badges ("▶ S6 E5") sit directly inside the thumbnail canvas.
5. **High-Contrast TV Typography**: High visual hierarchy with bold titles and crisp metadata pills designed for legibility at a 6-to-10 foot viewing distance.

---

## 2. Backdrop Layering & Subtle Scrim Gradients

### Layout Architecture
The detail view (`#details-view`) consists of three composited layers:
1. **Artwork Layer (`#detail-art`)**: Positioned fixed or absolute across `inset: 0` (`100vw × 100vh`).
   - Image uses `object-fit: cover` with `object-position: right top` or `right center` to preserve focal subjects.
   - For TV series without episode stills, falls back to show backdrop or clean dark canvas.
2. **Scrim Shade Layer (`#detail-shade`)**: Sits above the image (`pointer-events: none; inset: 0`).
   - **Horizontal Scrim**: Darkens the left side to provide 100% legibility for white text while keeping the right side luminous:
     ```css
     background: linear-gradient(90deg, 
       rgba(5, 7, 10, 0.98) 0%, 
       rgba(5, 7, 10, 0.92) 28%, 
       rgba(5, 7, 10, 0.65) 52%, 
       rgba(5, 7, 10, 0.15) 78%, 
       rgba(5, 7, 10, 0.00) 100%
     );
     ```
   - **Vertical Ground Scrim**: Anchors the bottom edge so episode rows and secondary rails blend seamlessly into deep black (`#05070a`):
     ```css
     linear-gradient(0deg, 
       #05070a 0%, 
       rgba(5, 7, 10, 0.88) 18%, 
       rgba(5, 7, 10, 0.00) 48%
     )
     ```
3. **Content Layer (`.detail-copy` & action bars)**: Placed at `z-index: 2` above the scrims.

### Artwork Crossfading & Stale Token Invalidation
- Switching focus or titles must never produce a sudden white flash or empty void.
- Always use image preloading with a double-buffered transition or CSS opacity fade (`transition: opacity 220ms ease-out`).
- Stale asynchronous loads must be guarded with an incrementing token (`detailToken` / `homeHeroToken`) to prevent out-of-order image replacement during rapid remote navigation.

---

## 3. Left-Side Detail Information Hierarchy

Reference geometry from `Prime(Episode).jpeg` and `Prime(DETAIL).jpeg`:

```
+--------------------------------------------------------------------------------+
| [Prime / Horizon Brand]                                                        |
| Title (Gilmore Girls)                                     [Cinematic Backdrop] |
|                                                                                |
| [Season 6 ▾]  (Pill dropdown)                                                  |
| 5. We've Got Magic to Do  (Episode title)                                      |
|                                                                                |
| Rory does a fabulous job organizing a big DAR bash...                          |
|                                                                                |
| [13+] [CC] [43 min] [2005] [✓ Included with Prime]                             |
|                                                                                |
| [ ▶ Resume S6 E2 ]  [Go ad free]  [More actions...]                            |
| ----------------- (progress fill)                                              |
|                                                                                |
| [ [▶ S6 E5] ] [ [S6 E6] ] [ [S6 E7] ] [ [S6 E8] ] ... (Landscape Carousel)     |
+--------------------------------------------------------------------------------+
```

### Proportions & Sizing
- **Left Safe Inset**: `clamp(36px, 4.5vw, 84px)` from left viewport edge.
- **Top Safe Inset**: `clamp(32px, 4vh, 72px)` from top viewport edge.
- **Copy Width**: Max width `min(54vw, 820px)` to prevent text from encroaching into focal faces on the right.
- **Title**: `clamp(32px, 3vw, 52px)`, font-weight 700, letter-spacing `-0.02em`, white `#ffffff`.
- **Episode Title**: `clamp(22px, 1.8vw, 30px)`, font-weight 600, color `#ffffff`.
- **Synopsis (Summary)**: `clamp(15px, 1.1vw, 19px)`, line-height 1.45, max 3 lines with ellipsis (`-webkit-line-clamp: 3`), color `rgba(255, 255, 255, 0.85)`.
- **Metadata Badges**:
  - Compact horizontal inline row with `gap: 0.5rem; align-items: center`.
  - Badges: `font-size: clamp(12px, 0.85vw, 14px)`, `background: rgba(255, 255, 255, 0.12)`, `border-radius: 4px`, `padding: 2px 7px`.
  - Audio/subtitle icons: crisp SVG or Unicode glyphs.

---

## 4. Season Dropdown & Action Controls

### Season Dropdown Pill
- As seen in `Prime(DETAIL).jpeg`, the season selector is a rounded pill button:
  - Text: `Season 6 ▾` (or `Season {N} ▾`).
  - Styling: `border-radius: 999px`, `background: rgba(255, 255, 255, 0.14)`, `color: #ffffff`, `font-size: 15px`, `font-weight: 600`, `padding: 8px 18px`.
  - Focused state: High-contrast white border (`2px solid #ffffff`), bright background (`rgba(255, 255, 255, 0.28)`), and soft aura glow (`box-shadow: 0 0 14px rgba(138, 186, 255, 0.45)`).
- When activated (`OK` / `Enter`), it displays a clean modal or floating vertical dropdown list of available seasons without reflowing the background layout.

### Action Button Row
- **Primary Action (Resume / Play)**:
  - Pill button with white background `#ffffff` and dark text `#0d1117` when focused, or dark pill with white text when unfocused.
  - Includes progress line underneath for partially watched media:
    ```css
    .detail-progress-track {
      position: absolute; bottom: 0; left: 12px; right: 12px; height: 3px;
      background: rgba(255, 255, 255, 0.3); border-radius: 2px; overflow: hidden;
    }
    .detail-progress-bar {
      height: 100%; background: #49aee8; width: 0%;
    }
    ```
- **Secondary Actions**: Compact circular or pill buttons (e.g. `Restart`, `Add to Watchlist`, `Trailer`).

---

## 5. 16:9 Landscape Episode Carousel

### Card Geometry
- **Aspect Ratio**: Exact `16 / 9` landscape thumbnails (e.g. `260px × 146px` on 1080p, scaling with `clamp(220px, 15vw, 300px)`).
- **Border Radius**: `8px` rounded corners.
- **Thumbnail Image**: `object-fit: cover; width: 100%; height: 100%`.
- **Badges**:
  - Bottom-left overlay: Episode number tag `▶ S6 E5` or `S6 E6` in bold text with dark semi-transparent pill backing (`background: rgba(0, 0, 0, 0.65); padding: 2px 8px; border-radius: 4px;`).
  - Bottom-edge progress line for partially watched episodes (`height: 3px; background: #3a83f7`).
- **Focus Indicator**:
  - TV cards must never rely on subtle color changes.
  - Focused state uses a crisp `2px solid #ffffff` outline, `outline-offset: 2px`, and an ambient blue-white aura:
    ```css
    .episode-card:focus,
    .episode-card.is-focused {
      outline: 2px solid #ffffff;
      outline-offset: 2px;
      box-shadow: 0 0 16px rgba(138, 186, 255, 0.55);
      transform: scale(1.03) translateZ(0);
      z-index: 10;
    }
    ```

---

## 6. Physical Vizio SmartCast Performance Guardrails

Vizio SmartCast runs an embedded WebKit/Chromium browser on low-cost MStar/MediaTek SoCs with constrained memory and limited GPU fill rates. Adhere strictly to these rules:

1. **NO Heavy Blur Filters**: Do **not** use `backdrop-filter: blur(...)` or heavy CSS `filter: blur(...)`. These trigger software rasterization fallbacks that drop rendering frame rates below 15fps.
2. **Use Pre-computed Linear Gradients**: Pure CSS linear gradients are hardware accelerated on SmartCast when applied to simple layer planes.
3. **Hardware-Accelerated Transitions**:
   - Animate **only** `transform` (`translate3d`, `scale`) and `opacity`.
   - Never animate `width`, `height`, `top`, `left`, `margin`, or `padding` during navigation, as these force layout reflows on the main thread.
4. **DOM Windowing & Recycling**:
   - For long episode lists or carousel rows, mount only visible items plus a small buffer (`visible + 2`). Never retain hundreds of unwindowed DOM nodes.
5. **Image Memory Management**:
   - Limit image resolution requests from TMDB to appropriate sizes (`w780` or `w1280` for backdrops, `w300` or `w500` for thumbnails). Never load raw uncompressed 4K assets.
   - Clean up detached `img` tags on view transitions to trigger garbage collection.

---

## 7. Architecture & Code Integration (`universal-search/`)

All Horizon UI code lives in vanilla JavaScript and CSS:
- **`universal-search/index.html`**: Semantic template structure for `#details-view` and `#episodes-view`.
- **`universal-search/search.css`**: CSS classes `.detail-view`, `.detail-art`, `.detail-shade`, `.detail-copy`, `.episode-list`, `.episode-play`.
- **`universal-search/search.js`**:
  - `renderDetailArt(title)`: Handles backdrop setting and fallback hierarchy.
  - `loadSeason(number, remember)`: Fetches season episodes and populates `#episode-list`.
  - `makeEpisodeCard(ep, seasonNumber)`: Builds DOM nodes for landscape episode thumbnails.
  - `syncStartedMarks()`: Synchronizes playback progress bars from `core.readHistory(local)`.
- **`universal-search/core.js`**: Storage contracts (`readBrowsedSeason`, `writeBrowsedSeason`, `lastWatchedEpisode`, `episodeProgressFraction`).

Always preserve existing ID hooks, accessibility attributes (`aria-label`, `role="status"`), and data attributes (`data-focus`, `data-season`, `data-episode`).
