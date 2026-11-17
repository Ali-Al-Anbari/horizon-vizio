---
name: horizon-focus-navigation
description: >-
  Specialized remote control focus navigation guide for Horizon on Vizio SmartCast TVs.
  Use this skill when implementing, refining, or debugging directional navigation (D-pad ArrowUp/Down/Left/Right),
  OK selection, Back key routing, directional focus graphs, season dropdowns, horizontal and vertical carousels,
  restoring last-selected episodes, viewport auto-scrolling, and preventing focus traps.
---

# Horizon TV Remote Focus & Navigation System

This skill defines the focus navigation architecture, D-pad graph state machine, and remote control input handling for Horizon on Vizio SmartCast TVs (`universal-search/search.js` and `frontend/horizon.js`).

---

## 1. Vizio Remote Hardware & Key Event Mapping

Vizio SmartCast remote controls communicate over infrared (IR) or low-energy Bluetooth. Input handling must account for SmartCast-specific event codes and hardware quirks.

### Key Value Normalization (`keyName(event)`)
Always normalize incoming keyboard events across legacy TV web engines:
```javascript
function keyName(event) {
  var key = event.key;
  var code = event.keyCode || event.which;
  if (key === "ArrowUp" || code === 38) return "ArrowUp";
  if (key === "ArrowDown" || code === 40) return "ArrowDown";
  if (key === "ArrowLeft" || code === 37) return "ArrowLeft";
  if (key === "ArrowRight" || code === 39) return "ArrowRight";
  if (key === "Enter" || code === 13) return "Enter";
  if (key === "Escape" || key === "Backspace" || key === "GoBack" || code === 27 || code === 8 || code === 10009) {
    return "Back";
  }
  return key;
}
```

### Missing `keyup` & Held-Key Inactivity Mitigation
SmartCast remotes frequently drop `keyup` events when directional buttons are held down. To prevent runaway auto-scrolling or locked states:
1. Detect repeated events: `event.repeat === true`.
2. Maintain an inactivity timer (default `240ms`):
   ```javascript
   holdMotion.inactivityTimer = clock.setTimeout(finishHoldMotion, 240);
   ```
3. Attach cancellation handlers on `window.blur` and `document.visibilitychange` to immediately cancel any active scroll or rapid step motions.

---

## 2. Focus Management Architecture in Horizon

Focus management in Horizon is centralized and explicit:

1. **Focusable Elements**: Every interactive element carries `data-focus` or `tabindex="-1"`.
2. **The `focus(element)` Function**:
   - Clears prior `.is-focused` classes.
   - Invokes `element.focus({ preventScroll: true })`.
   - Adds `.is-focused` class (ensuring consistent styling across TV browsers where native `:focus` pseudo-class can be unreliable).
   - Signals the performance monitor: `if (watchPerformance) watchPerformance.focusApplied();`.
   - Automatically invokes `revealInScroller(element, scroller, horizontal, padding)` to keep the active item fully within the visible TV viewport.
3. **Primary Entry Targets**:
   - Home / Watch: `get("watch-toggle")` or restored homepage card.
   - Details: `get("details-back")` or primary action button (`.detail-primary`).
   - Episodes: Current season button or last watched episode card.
   - Search: `get("query")` input or first search result.

---

## 3. Directional Focus Graphs by View

### A. Show Details View (`#details-view`)
The Show Details view consists of three primary vertical zones:
1. **Top Rail & Back Button (`#details-back`)**:
   - `ArrowDown`: Moves to the primary action button (`.detail-primary`) or Season dropdown.
   - `ArrowLeft`: Navigates to the active Left Rail toggle (`.watch-rail`).
2. **Action Button & Season Dropdown Zone (`#detail-actions`)**:
   - `ArrowUp`: Returns to `#details-back`.
   - `ArrowLeft` / `ArrowRight`: Steps through adjacent action buttons (`Resume`, `Go ad free`, `More ways to watch`, `Season dropdown`).
   - `ArrowDown`: Moves directly to the first visible card in the episode carousel (`#episode-list .episode-play:first-child`).
3. **Episode Carousel Zone (`#episodes-view` or inline row)**:
   - `ArrowUp`: Returns to the Season dropdown or primary action button.
   - `ArrowDown`: Moves to the recommendations row below (e.g., "Customers also watched").
   - `ArrowLeft` / `ArrowRight`: Steps through episode cards. At the left boundary (`index === 0`), `ArrowLeft` moves to the Left Rail or stops cleanly (no infinite wrap unless explicitly enabled).

---

## 4. Season Dropdown & Modal Focus Flow

Amazon Prime Video uses an inline/modal dropdown to select seasons. To implement this without breaking focus:

1. **Triggering the Dropdown (`Enter` on Season Pill)**:
   - Save the trigger element: `state.seasonDropdownTrigger = currentElement;`.
   - Open the dropdown overlay and set focus on the currently active season button:
     ```javascript
     var currentSeasonBtn = dropdownMenu.querySelector('[data-season="' + state.season + '"]');
     focus(currentSeasonBtn || dropdownMenu.querySelector("button"));
     ```
2. **Navigating the Dropdown List**:
   - Directional navigation (`ArrowUp` / `ArrowDown`) steps strictly within the dropdown options.
   - `ArrowLeft` and `ArrowRight` are absorbed or wrapped.
3. **Selecting a Season (`Enter` on a Season Item)**:
   - Close the dropdown menu.
   - Update state: `state.season = selectedSeasonNumber;`.
   - Call `core.writeBrowsedSeason(local, state.title.id, selectedSeasonNumber)`.
   - Load season episodes: `loadSeason(selectedSeasonNumber, true)`.
   - Transfer focus immediately to the first episode (or last watched episode) of the new season once rendered.
4. **Dismissing without Selection (`Back` or `Escape`)**:
   - Close the dropdown overlay.
   - Immediately restore focus to the season pill trigger: `focus(state.seasonDropdownTrigger);`.
   - Prevent event propagation so the `Back` key does not also navigate away from the Show Details screen.

---

## 5. Restoring Last-Selected & Active Episodes

Users returning to a series detail screen must never be forced to start over from Season 1 Episode 1.

### Resolution Hierarchy
When populating and focusing episodes, resolve the target episode using this precedence:
1. **Target Override (`pendingEpisodeFocus`)**: Set when returning from player or explicit deep-link.
2. **Last Watched Episode in History**:
   ```javascript
   var latest = core.lastWatchedEpisode(core.readHistory(local), state.title.id);
   ```
3. **Last Browsed Season**:
   ```javascript
   var browsedSeason = core.readBrowsedSeason(local, state.title.id);
   ```
4. **Default First Airing**: Season 1, Episode 1.

### Automatic Focus Transition
When `loadSeason` completes:
```javascript
if (pendingEpisodeFocus && pendingEpisodeFocus.season === number) {
  var targetCard = Array.from(list.querySelectorAll(".episode-play")).find(function (card) {
    return card.dataset.episode === String(pendingEpisodeFocus.episode);
  });
  pendingEpisodeFocus = null;
  if (targetCard) {
    focus(targetCard);
    return;
  }
}
// Fallback: focus first episode card or back button
var firstCard = list.querySelector(".episode-play");
if (firstCard && state.view === "episodes") {
  focus(firstCard);
}
```

---

## 6. Viewport Visibility & `revealInScroller`

On a 1080p TV display, an offscreen or partially obscured focused element creates extreme user confusion.

### Rules for Auto-Scrolling
1. Always use `preventScroll: true` in native `.focus()` calls to prevent uncoordinated browser jumping.
2. Rely on Horizon's `revealInScroller(element, scroller, horizontal, padding)`:
   - **Horizontal Scroller** (e.g. Episode Carousel):
     ```javascript
     var leftEdge = element.offsetLeft - scroller.scrollLeft;
     var rightEdge = leftEdge + element.offsetWidth;
     if (leftEdge < padding) {
       scroller.scrollLeft = Math.max(0, element.offsetLeft - padding);
     } else if (rightEdge > scroller.clientWidth - padding) {
       scroller.scrollLeft = element.offsetLeft + element.offsetWidth + padding - scroller.clientWidth;
     }
     ```
   - **Vertical Scroller** (e.g. History Grid, Settings): Keep a 24px–48px safety cushion above and below the element.

---

## 7. Preventing Focus Traps & Focus Loss

Focus loss occurs when an element currently holding focus is removed from the DOM (e.g., via `replaceChildren()`), causing `document.activeElement` to revert to `<body>`.

### Prevention Strategies
1. **Pre-mutation Target Retention**:
   - Before rebuilding a container, record the focused index or identity:
     ```javascript
     var savedIndex = Array.from(container.children).indexOf(doc.activeElement);
     ```
2. **Post-mutation Focus Restoration**:
   - If `doc.activeElement === doc.body` or `!doc.body.contains(doc.activeElement)`, immediately recover focus to a fallback anchor:
     ```javascript
     function ensureFocus(fallbackElement) {
       if (!doc.activeElement || doc.activeElement === doc.body || !doc.body.contains(doc.activeElement)) {
         focus(fallbackElement);
       }
     }
     ```
3. **Back Key Safety**:
   - Never let `Back` exit the application unless the user is on the root Home screen and confirms exit.
   - View hierarchy for Back:
     - `Modal / Dropdown` -> `Current View Trigger`
     - `Episodes View` -> `Details View`
     - `Details View` -> `Source View (Watch Home / Search / History)`
     - `History All / Settings Subpage` -> `History / Settings Landing`
