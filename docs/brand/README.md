# Brand files

| File | Use it for |
|---|---|
| `petty-logo.svg` | The primary logo (icon + wordmark) on light backgrounds: README, docs, slides. |
| `petty-logo-dark.svg` | The same for dark backgrounds (light wordmark, lighter sparks). |
| `../../apps/web/public/icon.svg` | The icon alone, full colour: app icon, landing page. The source of the geometry. |
| `../../apps/web/public/favicon.svg` | The icon alone, flat green: favicon and anything under 32 px, where the gradient and sparks would vanish. |

Colours: gradient `#5cb37a` → `#1f6a45`, spark and accent `#2f6f4f`, ink `#1d2b25`.
Palette tokens live in `apps/web/src/styles/tokens.css` (light and dark). The app, its icons (Lucide,
drawn in `--accent` on a tinted tile) and any mockup should use these and nothing else:

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#f5f3ef` | `#151412` | page ground |
| `--card` | `#ffffff` | `#201e1b` | cards, chips, sheets |
| `--text` | `#1c1a17` | `#f0ece4` | text |
| `--muted` | `#5f5a50` | `#a8a094` | secondary text, meta rows |
| `--border` | `#e5e0d8` | `#332f2a` | hairlines |
| `--accent` | `#2f6f4f` | `#4c9c72` | primary buttons, selected chips, icons, "verified" |
| `--accent-text` | `#ffffff` | `#0b1210` | text on accent |
| `--danger` / `--withdraw` | `#b3432b` | `#e0725a` | delete, negative amounts, withdraw |
| `--adjust` | `#8a6d1f` | `#d4ac3f` | "needs verification", adjust entries |
| `--k-money` | `#2e7a4f` | `#5fb88a` | a money line's tile and dot |
| `--k-things` | `#2f63a8` | `#7fa9e8` | a counted line's tile and dot |
| `--k-notes` | `#9a5f12` | `#e0a95a` | a single item's tile and dot |

Tinted grounds (total card, icon tiles) are `color-mix(in srgb, var(--accent) 9–14%, var(--card))`;
a line's tile uses its kind's colour instead (`--k-*` at 15%, PETTY-250), as the landing page does.
Pictures (the landing examples, a drawer's header, the home beside the total) are bubbles round a
middle, joined by dashed spokes: the middle in `--accent`, the bubbles tinted by kind.

In Markdown, switch by the viewer's colour scheme:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/petty-logo-dark.svg">
  <img src="docs/brand/petty-logo.svg" alt="Petty" width="250">
</picture>
```

The wordmark is live text in the system font, so it renders slightly differently per
platform. Convert it to paths if it must be pixel-identical (for print, say).
