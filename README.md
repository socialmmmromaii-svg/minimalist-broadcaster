# Minimalist Broadcaster

**A free, open-source, browser-based live streaming studio.** Scenes, sources, an audio mixer,
preview/program switching with transitions, local recording and WHIP streaming — with no install,
no accounts and no license fees.

> Runs entirely in your browser. Nothing is uploaded anywhere until you press **Stream**.

---

## Features

### Studio
- **Preview / Program canvases** in OBS-style studio mode — build the next shot in Preview,
  take it live with one button.
- **Transitions**: Cut, Fade, Move (horizontal push) and Slide, with a duration from 0–2000 ms.
- **Scenes**: create, duplicate, rename (double-click or `F2`), delete; the list shows which scene
  is on air and which is staged in preview.
- **Sources per scene**, with layer ordering (Up/Down), per-source visibility and removal.

### Source types
| Source | What it does |
| --- | --- |
| Screen / window capture | `getDisplayMedia`, optional system audio |
| Camera | `getUserMedia`, optional device audio |
| Lower third | Accent bar + headline + subline, auto-shrinking text |
| Title text | Bold, sized, left/centre/right aligned |
| Image | PNG/JPEG/GIF/WebP (small images persist between sessions) |
| Video file | Loops, optional audio routed to the mixer |
| Audio file | Music beds / stingers, loops by default, metered in the mixer |
| Clock | 12/24-hour, live |
| Colour background | Solid fill for a scene |

### Canvas editing
- Click a source to select it, drag to move, drag a corner to resize (both in Preview).
- Live transform label (position + size) while you drag.
- Arrow keys nudge the selected source; `Shift`+arrow nudges by 10 px; `Delete` removes it.
- Properties panel edits position, size, visibility and per-type options numerically.

### Audio mixer
- Per-source fader (0–150 %) with mute, and a **Master** bus with its own fader, mute and meter.
- Live VU meters with dB read-out (meter reads pre-mute, post-fader — like a real console).
- Camera/screen audio, video and audio-file sources are all routed through the same bus.
- The same bus feeds the recording and the stream, so levels match what you hear.

### Output
- **Record** the program output (video + mixer audio) to a timestamped WebM file, one click, local.
- **Stream** over WebRTC to a **WHIP** endpoint. RTMP is not possible inside a browser tab, so the
  Stream panel takes a WHIP URL from a free, open-source relay in front of your platform:
  - [MediaMTX](https://github.com/bluenviron/mediamtx) ·
    [OvenMediaEngine](https://github.com/AirenSoft/OvenMediaEngine) ·
    [SRS](https://github.com/ossrs/srs)
  - The panel also stores your RTMP server URL + stream key so your relay can push to
    YouTube, Twitch, Facebook, Kick, etc.

### Quality-of-life
- Everything (scenes, sources, faders, transition, destination) persists in your browser's
  `localStorage`; **Settings → Reset** restores the factory layout.
- Canvas resolution 1920×1080 / 1280×720 / 854×480 at 60 / 30 / 24 fps — existing layouts scale
  proportionally when you change resolution.
- Keyboard shortcuts, toasts for every action, empty states everywhere, WCAG AA colour contrast
  (axe-core: **0 violations**).
- Responsive down to small screens (the studio stacks vertically below 1180 px).

---

## Quick start

No build step, no dependencies — it is plain HTML/CSS/ES modules.

```bash
git clone <this-repo>
cd minimalist-broadcaster
python -m http.server 8093      # or: npx serve .
# open http://127.0.0.1:8093
```

Any static host works (Vercel, Netlify, GitHub Pages, nginx…). Deploy it as a static site.

**Permissions**: camera/screen capture ask for permission once per source. Everything works over
`http://localhost` (a secure context); when you deploy it, HTTPS is required for capture and WHIP.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Take Preview → Program (selected transition) |
| `Ctrl`+`Space` | Cut instantly |
| `R` | Start / stop recording |
| `S` | Open settings |
| `Delete` | Remove the selected source |
| `↑ ↓ ← →` | Nudge the selected source (`Shift` = 10 px) |
| `F2` | Rename the selected scene |

---

## Project layout

```
index.html      studio shell: header, canvases, panels, dialogs
styles.css      design system (dark broadcast palette, spacing scale, responsive)
js/store.js     state model + localStorage persistence + pub/sub
js/renderer.js  scene compositing, media lifecycle, drag/resize interaction, transitions
js/audio.js     WebAudio mixer: per-source gain/meter/mute + master bus
js/output.js    MediaRecorder recording and WebRTC/WHIP streaming
js/ui.js        panels, properties, mixer rows, tabs, toasts
js/main.js      bootstrap: wires everything, keyboard shortcuts, status
```

---

## Limitations (honest list)

- **RTMP from the browser is impossible** (no raw socket access) — use a WHIP relay as described.
- Image sources larger than ~1.5 MB, and all video/audio files, live for the session only
  (the layout persists, the file does not re-load after a refresh).
- Recording produces WebM (VP9/VP8 + Opus); platform-specific MP4 conversion is a post-step.
- A single tab cannot stream to several destinations at once — fan-out is the relay's job.

---

## Roadmap

- Stinger/colour-chip transitions and scene collections (folders + profiles).
- Browser-source (URL) layer, NDI/WebRTC ingest of remote guests.
- Per-source filters (chroma key, blur, crop), vertical 9:16 templates.
- One-click presets for churches, podcasts, education and short-form.

Contributions welcome — keep the README in sync with every feature you add.

## License

MIT — see [LICENSE](LICENSE).
