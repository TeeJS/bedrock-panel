# Bedrock Panel typography


**Face:** Segoe UI Bold. **Weight:** 700. **Style:** normal. **Tracking:** 0 (no added letter spacing). **Case:** Bedrock Panel. The SVG stores outlined letters; it does not need any font installed.

UI/web fallback stack: `"Segoe UI", -apple-system, BlinkMacSystemFont, "Roboto", Arial, sans-serif`.

Fallbacks are for surrounding UI only. They do not reproduce the exact wordmark. For exact branding use the supplied SVG, not live text.

| Horizontal master property | Value |
| --- | --- |
| Canvas / viewBox | 1000 x 220 |
| Wordmark em size | 106 px |
| GDI+ text drawing origin | x=220, y=52 |
| Mark nominal viewport | x=0, y=10, 200 x 200 |
| Visible mark bounds | x=40..172, y=38..182 |
| Visible text ink bounds (x, y, width, height) | 228.488, 87.920, 692.623, 79.759 |

The drawing origin includes font metrics; it is not a CSS baseline or the visible top-left of the letters. `lockup-metrics.json` records the exact values. Preserve the SVG viewBox to retain spacing.

| Display width | Display height | Effective wordmark em | Nominal mark box |
| --- | --- | --- | --- |
| 1000 px master | 220 px | 106 px | 200 px |
| 500 px | 110 px | 53 px | 100 px |
| 250 px | 55 px | 26.5 px | 50 px |
| 200 px minimum full lockup | 44 px | 21.2 px | 40 px |

For `<img>`, set width and `height: auto`; no line-height applies to an image. A nearby live-text UI label may use `font-weight: 700; letter-spacing: 0; line-height: 1.2`, but is not the master lockup.

**Original stacked master:** canvas 1000 x 680; mark viewport x=310, y=5, size=380; same Segoe UI Bold at 110 px em; text drawing origin x=105, y=405. This preserves the original one-line name below the mark.




Body text: Segoe UI Regular (400), 16–18 px, line-height 1.55. Headings: Semibold (600) or Bold (700), 24–48 px. Code stack: `Consolas, "SFMono-Regular", "Liberation Mono", monospace`. No font binaries are redistributed.
