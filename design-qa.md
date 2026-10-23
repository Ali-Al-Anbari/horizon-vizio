# Horizon visual review

**Final result: passed** for the local browser implementation. The reference and final native-size screenshots were viewed side by side. Vizio hardware behavior remains to be checked on the TV.

## Reference specifications

The supplied image is 1146 × 646. Its header wordmark begins around (50, 48); its time control is at the top right. A cinematic image fills the frame, with three figures centered over a warm geometric light source. The rounded translucent dock starts near (23, 468), spans about 1090 × 135, and contains six wide tiles. The next row enters at y ≈ 628. The focused first tile grows by roughly ten percent with restrained shadow.

## Three visual passes

1. **Initial reconstruction:** Added original three-figure cinematic art, the top header, wide six-tile glass dock, and second row. The old centered square grid was removed.
2. **Geometry and tone:** Adjusted the dock to 1091 × 136 at (23, 468), moved the second row to y = 628, lowered the wordmark, and reduced hero saturation and brightness.
3. **Composition and states:** Moved the green Live TV tile into the reference's fourth position, refined the focused border, replaced the Settings glyph with a library icon, and checked Settings, browser, and second-row screenshots.

## Five largest initial mismatches and fixes

| Mismatch in first render | Reference evidence | Fix |
| --- | --- | --- |
| Horizon wordmark sat too high and was too narrow | Reference starts near y = 48 with wide tracking | Lowered the wordmark and increased its size and tracking while keeping Horizon branding |
| Dock was about 10 px too wide | Reference right edge near x = 1113 | Changed the right inset to 2.8vw; final right edge is x = 1114 |
| Second row began about 7 px too low | Reference next row begins near y = 628 | Reduced grid row gap; final row begins at y = 628 |
| Hero was brighter and more saturated | Reference uses muted steel blue and warm highlights | Reduced brightness and saturation of the original hero image |
| Green tile appeared one position too late | Reference fourth tile is green | Moved Live TV into the fourth dock position |

## Final evidence and limits

- Reference: `/Users/alialanbari/Downloads/reference.jpeg`
- Native-size comparison: `/private/tmp/horizon-assets/horizon-side-by-side.png`
- Final 1080p home: `/private/tmp/horizon-assets/horizon-1080-final.png`
- Final 4K home: `/private/tmp/horizon-assets/horizon-4k-final.png`
- Focus, Settings, browser, and second-row captures share the same directory.

Final browser geometry at 1146 × 646: dock (23, 468, 1091, 136); first tile (37, 489, 167, 94); next row begins at y = 628. At 1920 × 1080 and 3840 × 2160, all primary controls remain within horizontal safe margins. All tile art loaded with no console errors or failed requests.

The original show art and Apple app icons were replaced with original cinematic art and Horizon's configured services. The central figures and brands therefore differ from the reference by design. The generated hero is 1672 × 941 source pixels and is scaled for 4K output. The browser and streaming app launches are still unavailable; the UI says so when selected. Chrome measurements are not Vizio hardware measurements.
