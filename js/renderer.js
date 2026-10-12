/**
 * renderer.js — scene compositing onto the preview and program canvases,
 * plus pointer interaction (select / move / resize) on the preview canvas.
 *
 * All geometry is expressed in *virtual* pixels (the canvas resolution held in
 * store.resolution). The canvases are scaled by CSS, so pointer coordinates are
 * mapped back through getBoundingClientRect().
 */

import { getState, previewScene, update, updateSource, subscribe, scheduleSave } from './store.js';

const HANDLE = 18;            // resize handle size, virtual px
const MIN_SIZE = 24;          // minimum source size, virtual px

/* ----------------------------------------------------------------- media -- */

/** id -> { kind, el, stream, error, url, ready } */
const media = new Map();
let mediaResolvedListener = null;

/** Registered by main.js so the mixer can attach as soon as media is ready. */
export function onMediaResolved(fn) {
  mediaResolvedListener = fn;
}

function notifyResolved(id) {
  if (mediaResolvedListener) {
    try { mediaResolvedListener(id); } catch (err) { console.error('media listener failed', err); }
  }
}

function mediaKindOf(type) {
  if (type === 'image' || type === 'video' || type === 'audio' || type === 'camera' || type === 'display') return type;
  return null;
}

function dispose(entry) {
  if (entry.stream) {
    for (const t of entry.stream.getTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
  }
  if (entry.el) {
    try { entry.el.pause(); } catch { /* ignore */ }
    if (entry.kind === 'camera' || entry.kind === 'display') entry.el.srcObject = null;
  }
  if (entry.url) URL.revokeObjectURL(entry.url);
}

function makeElement(kind) {
  const el = document.createElement(kind === 'image' ? 'img' : 'video');
  if (el instanceof HTMLVideoElement) {
    el.muted = false;
    el.playsInline = true;
    el.loop = true;
    el.preload = 'auto';
    el.autoplay = true;
  }
  return el;
}

async function acquire(kind, src) {
  const entry = { kind, el: null, stream: null, error: null, url: null, ready: false, srcRef: null };

  try {
    if (kind === 'camera') {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: !!src.props.withAudio,
      });
      const video = makeElement(kind);
      video.muted = true; // monitoring goes through the mixer only
      video.srcObject = stream;
      await video.play().catch(() => {});
      entry.el = video;
      entry.stream = stream;
    } else if (kind === 'display') {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: !!src.props.withAudio,
      });
      const video = makeElement(kind);
      video.muted = true;
      video.srcObject = stream;
      // screen capture video must not loop
      video.loop = false;
      await video.play().catch(() => {});
      entry.el = video;
      entry.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (track) track.addEventListener('ended', () => { entry.error = 'Capture stopped'; });
    } else if (kind === 'image') {
      entry.srcRef = src.props.src || null;
      if (src.props.src) {
        const img = new Image();
        img.decoding = 'async';
        img.src = src.props.src;
        if (img.decode) await img.decode().catch(() => {});
        else await new Promise((r) => { img.onload = r; img.onerror = r; });
        entry.el = img;
        entry.ready = img.naturalWidth > 0;
        if (src.props.src.startsWith('blob:')) entry.url = src.props.src;
      }
    } else if (kind === 'video' || kind === 'audio') {
      entry.srcRef = src.props.src || null;
      if (src.props.src) {
        const video = makeElement(kind);
        if (kind === 'audio') video.style.width = '0'; // audio-only placeholder
        video.muted = !!src.props.muted;
        // music beds loop by default; video clips need the option enabled
        video.loop = kind === 'audio' ? src.props.loop !== false : !!src.props.loop;
        video.src = src.props.src;
        entry.el = video;
        if (src.props.src.startsWith('blob:')) entry.url = src.props.src;
        await video.play().catch(() => { /* autoplay may be blocked until interaction */ });
        entry.ready = true;
      }
    }
  } catch (err) {
    entry.error = err && err.name ? `${err.name}` : 'Failed to open source';
    console.warn('media acquire failed for', src.id, err);
  }

  return entry;
}

function collectMediaSources(state) {
  const found = new Map();
  for (const scene of state.scenes) {
    for (const src of scene.sources) {
      const kind = mediaKindOf(src.type);
      if (kind && !found.has(src.id)) found.set(src.id, { kind, src });
    }
  }
  return found;
}

/** Reconcile the media registry with the current state. */
function syncMedia(state) {
  const wanted = collectMediaSources(state);

  for (const [id, entry] of [...media.entries()]) {
    if (!wanted.has(id)) {
      dispose(entry);
      media.delete(id);
    }
  }

  for (const [id, { kind, src }] of wanted) {
    const existing = media.get(id);
    if (!existing) {
      const created = acquire(kind, src);
      media.set(id, created);
      created.then((resolved) => {
        // only install if the entry is still current
        if (media.get(id) === created) {
          media.set(id, resolved);
          notifyResolved(id);
        }
      });
      continue;
    }
    const refresh = kind === 'image' || kind === 'video' || kind === 'audio';
    if (!refresh) return;
    Promise.resolve(existing).then((entry) => {
      if (!entry || media.get(id) !== entry) return;
      const wantedSrc = src.props.src || null;
      if (entry.srcRef === wantedSrc) return;
      const pending = acquire(kind, src);
      media.set(id, pending);
      pending.then((resolved) => {
        if (media.get(id) === pending) {
          media.set(id, resolved);
          notifyResolved(id);
        }
      });
    });
  }
}

/**
 * Browsers block autoplay for audible media until a user gesture. Called on
 * the first gesture (and whenever the mixer is touched) to start anything
 * that should be playing.
 */
export function resumeMediaPlayback() {
  for (const entry of media.values()) {
    if (entry instanceof Promise) continue;
    const el = entry && entry.el;
    if (!el || !(el instanceof HTMLMediaElement)) continue;
    if (entry.kind !== 'video' && entry.kind !== 'audio') continue;
    if (el.paused || el.ended) {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }
}

/** Snapshot of every managed media entry — surfaced as window.__mb.mediaInfo(). */
export function mediaDiagnostics() {
  const out = [];
  for (const [id, entry] of media) {
    if (entry instanceof Promise) { out.push({ id, pending: true }); continue; }
    const el = entry && entry.el;
    out.push({
      id,
      kind: entry.kind,
      error: entry.error || null,
      hasEl: !!el,
      paused: el && 'paused' in el ? el.paused : null,
      readyState: el && 'readyState' in el ? el.readyState : null,
      muted: el && 'muted' in el ? el.muted : null,
      loop: el && 'loop' in el ? el.loop : null,
      src: el ? String(el.currentSrc || el.src || '').slice(0, 24) : null,
    });
  }
  return out;
}

/** Resolve the (possibly still pending) media entry for a source id. */
export function getMedia(sourceId) {
  const entry = media.get(sourceId);
  if (!entry) return null;
  if (entry instanceof Promise) return null; // not ready yet
  return entry;
}

/* --------------------------------------------------------------- drawing -- */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fitFont(ctx, text, size, boxW, maxIterations = 60) {
  let s = size;
  while (s > 9) {
    ctx.font = `700 ${s}px system-ui, "Segoe UI", Roboto, sans-serif`;
    if (ctx.measureText(text).width <= boxW) return s;
    s -= 1;
    if (maxIterations-- <= 0) break;
  }
  return Math.max(9, s);
}

function drawMediaElement(ctx, el, x, y, w, h, kind) {
  const sw = el.videoWidth || el.naturalWidth || 0;
  const sh = el.videoHeight || el.naturalHeight || 0;
  if (!sw || !sh) return false;
  // "cover" the box, centred
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  return true;
}

function drawClock(ctx, src) {
  const { x, y, w, h } = src;
  const now = new Date();
  const text = src.props.format24 === false
    ? now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : now.toLocaleTimeString('en-GB', { hour12: false });
  const size = fitFont(ctx, text, Math.min(h * 0.6, w * 0.3), w * 0.9);
  ctx.font = `600 ${size}px ui-monospace, "Cascadia Mono", Menlo, monospace`;
  ctx.fillStyle = src.props.color || '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2);
}

function drawText(ctx, src) {
  const { x, y, w, h } = src;
  const text = String(src.props.text ?? '');
  if (!text) return;
  let size = Math.max(10, Number(src.props.fontSize) || Math.round(h * 0.5));
  const family = 'system-ui, "Segoe UI", Roboto, sans-serif';
  const weight = src.props.bold === false ? '400' : '700';
  // shrink to fit the box
  for (let i = 0; i < 60 && size > 9; i += 1) {
    ctx.font = `${weight} ${size}px ${family}`;
    const m = ctx.measureText(text);
    if (m.width <= w * 0.94 && size <= h * 0.9) break;
    size -= 1;
  }
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.fillStyle = src.props.color || '#ffffff';
  ctx.textBaseline = 'middle';
  const align = src.props.align || 'left';
  ctx.textAlign = align;
  const px = align === 'left' ? x : align === 'right' ? x + w : x + w / 2;
  ctx.fillText(text, px, y + h / 2);
}

function drawLowerThird(ctx, src) {
  const { x, y, w, h } = src;
  const headline = String(src.props.headline ?? '');
  const subline = String(src.props.subline ?? '');
  if (!headline && !subline) return;

  const pad = Math.max(6, h * 0.1);
  const panelY = y;
  const panelH = h;

  ctx.save();
  ctx.fillStyle = 'rgba(12, 15, 18, 0.86)';
  roundRect(ctx, x, panelY, w, panelH, Math.min(8, panelH * 0.14));
  ctx.fill();

  const accent = src.props.accent || '#35c4b5';
  ctx.fillStyle = accent;
  const barW = Math.max(4, w * 0.012);
  roundRect(ctx, x, panelY, barW + 4, panelH, Math.min(8, panelH * 0.14));
  ctx.fill();
  ctx.fillStyle = 'rgba(12, 15, 18, 0.86)';
  ctx.fillRect(x + barW, panelY, barW + 2, panelH);

  const family = 'system-ui, "Segoe UI", Roboto, sans-serif';
  let headSize = Math.round(Number(src.props.fontSize) || panelH * 0.42);
  headSize = Math.max(10, Math.min(headSize, panelH * 0.5));
  const innerX = x + barW + pad;
  const innerW = w - barW - pad * 2;

  for (let i = 0; i < 60 && headSize > 9; i += 1) {
    ctx.font = `700 ${headSize}px ${family}`;
    if (ctx.measureText(headline).width <= innerW) break;
    headSize -= 1;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f5f7f9';
  const baseY = subline ? panelY + panelH * 0.52 : panelY + panelH * 0.68;
  ctx.fillText(headline, innerX, baseY, innerW);

  if (subline) {
    let subSize = Math.max(9, Math.round(headSize * 0.55));
    for (let i = 0; i < 40 && subSize > 8; i += 1) {
      ctx.font = `400 ${subSize}px ${family}`;
      if (ctx.measureText(subline).width <= innerW) break;
      subSize -= 1;
    }
    ctx.font = `400 ${subSize}px ${family}`;
    ctx.fillStyle = accent;
    ctx.fillText(subline, innerX, panelY + panelH * 0.86, innerW);
  }
  ctx.restore();
}

function drawAudioPill(ctx, src) {
  const { x, y, w, h } = src;
  ctx.save();
  ctx.fillStyle = 'rgba(38, 42, 48, 0.92)';
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#35c4b5';
  ctx.font = `700 ${Math.max(10, Math.round(h * 0.34))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('♪  AUDIO', x + w / 2, y + h * 0.4);
  ctx.fillStyle = 'rgba(231,233,236,0.7)';
  ctx.font = `400 ${Math.max(9, Math.round(h * 0.22))}px system-ui, sans-serif`;
  ctx.fillText(src.name, x + w / 2, y + h * 0.75, w * 0.9);
  ctx.restore();
}

function drawMissing(ctx, src, message) {
  const { x, y, w, h } = src;
  ctx.save();
  ctx.fillStyle = 'rgba(20, 24, 28, 0.9)';
  ctx.strokeStyle = 'rgba(229, 72, 77, 0.7)';
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#e5484d';
  ctx.font = `600 ${Math.max(11, Math.min(h * 0.16, 18))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message || 'No signal', x + w / 2, y + h / 2, w * 0.9);
  ctx.restore();
}

function drawSource(ctx, src, now) {
  if (!src.visible) return;
  const { x, y, w, h } = src;
  ctx.save();

  try {
    switch (src.type) {
      case 'color': {
        ctx.fillStyle = src.props.color || '#10151b';
        ctx.fillRect(x, y, w, h);
        break;
      }
      case 'text':
        drawText(ctx, src);
        break;
      case 'lower-third':
        drawLowerThird(ctx, src);
        break;
      case 'clock':
        drawClock(ctx, src);
        break;
      case 'image': {
        if (!src.props.src) { drawMissing(ctx, src, 'No media file'); break; }
        const entry = getMedia(src.id);
        const img = entry && entry.el;
        if (img && img.complete && img.naturalWidth) {
          if (!drawMediaElement(ctx, img, x, y, w, h)) drawMissing(ctx, src, 'Image unavailable');
        } else if (entry && entry.error) {
          drawMissing(ctx, src, 'Image unavailable');
        } else {
          drawMissing(ctx, src, 'Loading…');
        }
        break;
      }
      case 'video':
      case 'camera':
      case 'display': {
        if (src.type === 'video' && !src.props.src) { drawMissing(ctx, src, 'No media file'); break; }
        const entry = getMedia(src.id);
        const video = entry && entry.el;
        if (entry && entry.error && !video) {
          drawMissing(ctx, src, entry.error);
        } else if (video && video.readyState >= 2 && video.videoWidth) {
          if (!drawMediaElement(ctx, video, x, y, w, h)) drawMissing(ctx, src, 'No signal');
        } else {
          drawMissing(ctx, src, 'Waiting for signal…');
        }
        break;
      }
      case 'audio':
        drawAudioPill(ctx, src);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('draw failed for source', src.id, err);
  }

  ctx.restore();
  void now;
}

export function drawScene(ctx, scene, state, now) {
  const { w, h } = state.resolution;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!scene) return;
  for (const src of scene.sources) drawSource(ctx, src, now);
}

/* ---------------------------------------------------------- interactions -- */

let previewCanvas = null;
let programCanvas = null;
let previewCtx = null;
let programCtx = null;
let scratchA = null;
let scratchB = null;
let drag = null;              // { sourceId, mode, corner, startX, startY, orig }
let fps = 0;
let frames = 0;
let fpsStamp = 0;

const transition = {
  active: false,
  type: 'fade',
  duration: 0,
  startedAt: 0,
  outgoingId: null,
  incomingId: null,
};

export function isTransitioning() {
  return transition.active;
}

export function startTransition(type, duration, outgoingId, incomingId) {
  if (type === 'cut' || duration <= 0) {
    transition.active = false;
    return;
  }
  transition.active = true;
  transition.type = type;
  transition.duration = duration;
  transition.startedAt = performance.now();
  transition.outgoingId = outgoingId;
  transition.incomingId = incomingId;
}

function virtualPoint(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const state = getState();
  const sx = (evt.clientX - rect.left) * (state.resolution.w / rect.width);
  const sy = (evt.clientY - rect.top) * (state.resolution.h / rect.height);
  return { x: sx, y: sy };
}

function sceneAt(id) {
  const state = getState();
  return state.scenes.find((s) => s.id === id) || null;
}

function hitTest(scene, point) {
  if (!scene) return null;
  for (let i = scene.sources.length - 1; i >= 0; i -= 1) {
    const s = scene.sources[i];
    if (!s.visible) continue;
    if (point.x >= s.x && point.x <= s.x + s.w && point.y >= s.y && point.y <= s.y + s.h) return s;
  }
  return null;
}

function cornerAt(scene, point) {
  if (!scene) return null;
  for (let i = scene.sources.length - 1; i >= 0; i -= 1) {
    const s = scene.sources[i];
    if (!s.visible) continue;
    const corners = [
      ['nw', s.x, s.y],
      ['ne', s.x + s.w, s.y],
      ['sw', s.x, s.y + s.h],
      ['se', s.x + s.w, s.y + s.h],
    ];
    for (const [corner, cx, cy] of corners) {
      if (Math.abs(point.x - cx) <= HANDLE && Math.abs(point.y - cy) <= HANDLE) return { sourceId: s.id, corner };
    }
  }
  return null;
}

function setupInteraction(canvas) {
  const state = () => getState();

  canvas.addEventListener('pointerdown', (evt) => {
    const point = virtualPoint(canvas, evt);
    const scene = previewScene();
    const corner = cornerAt(scene, point);
    if (corner) {
      drag = { mode: 'resize', ...corner, startX: point.x, startY: point.y, orig: null };
    } else {
      const hit = hitTest(scene, point);
      if (hit) {
        update((s) => { s.selectedSourceId = hit.id; });
        drag = {
          mode: 'move',
          sourceId: hit.id,
          startX: point.x,
          startY: point.y,
          orig: { x: hit.x, y: hit.y },
        };
      } else {
        update((s) => { s.selectedSourceId = null; });
        drag = null;
      }
    }
    if (drag) {
      const s = scene && scene.sources.find((x) => x.id === drag.sourceId);
      drag.orig = s ? { x: s.x, y: s.y, w: s.w, h: s.h } : null;
      canvas.classList.add('is-dragging');
      try { canvas.setPointerCapture(evt.pointerId); } catch { /* synthetic events have no pointer to capture */ }
      evt.preventDefault();
    }
    renderPropsIfChanged();
  });

  canvas.addEventListener('pointermove', (evt) => {
    if (!drag) {
      const point = virtualPoint(canvas, evt);
      const scene = previewScene();
      const h = cornerAt(scene, point);
      canvas.style.cursor = h
        ? (h.corner === 'nw' || h.corner === 'se' ? 'nwse-resize' : 'nesw-resize')
        : (hitTest(scene, point) ? 'grab' : 'default');
      return;
    }

    const point = virtualPoint(canvas, evt);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    const res = state().resolution;

    updateSource(drag.sourceId, (src) => {
      if (drag.mode === 'move' && drag.orig) {
        src.x = Math.round(clamp(drag.orig.x + dx, -src.w + 24, res.w - 24));
        src.y = Math.round(clamp(drag.orig.y + dy, -src.h + 24, res.h - 24));
        return;
      }
      if (drag.mode === 'resize' && drag.orig) {
        const o = drag.orig;
        let { x, y, w, h } = o;
        if (drag.corner.includes('e')) w = Math.max(MIN_SIZE, o.w + dx);
        if (drag.corner.includes('s')) h = Math.max(MIN_SIZE, o.h + dy);
        if (drag.corner.includes('w')) {
          const nw = Math.max(MIN_SIZE, o.w - dx);
          x = o.x + (o.w - nw);
          w = nw;
        }
        if (drag.corner.includes('n')) {
          const nh = Math.max(MIN_SIZE, o.h - dy);
          y = o.y + (o.h - nh);
          h = nh;
        }
        src.x = Math.round(x); src.y = Math.round(y);
        src.w = Math.round(w); src.h = Math.round(h);
      }
    });
    renderPropsIfChanged(true);
  });

  const endDrag = (evt) => {
    if (!drag) return;
    drag = null;
    canvas.classList.remove('is-dragging');
    try { canvas.releasePointerCapture(evt.pointerId); } catch { /* ignore */ }
    scheduleSave();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('keydown', (evt) => {
    const sel = state().selectedSourceId;
    if (!sel) return;
    const step = evt.shiftKey ? 10 : 1;
    const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = deltas[evt.key];
    if (d) {
      evt.preventDefault();
      updateSource(sel, (src) => {
        src.x += d[0];
        src.y += d[1];
      });
      scheduleSave();
    }
  });
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

let renderPropsRaf = 0;
/**
 * Ask the properties panel to refresh.
 * @param {boolean} numbersOnly - true while dragging: only x/y/w/h changed.
 */
function renderPropsIfChanged(numbersOnly = false) {
  if (numbersOnly) {
    cancelAnimationFrame(renderPropsRaf);
    renderPropsRaf = 0;
  }
  if (renderPropsRaf) return;
  renderPropsRaf = requestAnimationFrame(() => {
    renderPropsRaf = 0;
    const ui = window.__mb;
    if (ui && typeof ui.renderProps === 'function') ui.renderProps(numbersOnly);
  });
}

function drawSelection(ctx, scene, state) {
  const selId = state.selectedSourceId;
  if (!selId) return;
  const src = scene.sources.find((s) => s.id === selId);
  if (!src) return;

  ctx.save();
  ctx.strokeStyle = '#35c4b5';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(src.x, src.y, src.w, src.h);

  const corners = [
    [src.x, src.y], [src.x + src.w, src.y],
    [src.x, src.y + src.h], [src.x + src.w, src.y + src.h],
  ];
  ctx.fillStyle = '#0f1113';
  ctx.strokeStyle = '#35c4b5';
  for (const [cx, cy] of corners) {
    ctx.beginPath();
    ctx.rect(cx - 5, cy - 5, 10, 10);
    ctx.fill();
    ctx.stroke();
  }

  ctx.font = '600 12px system-ui, sans-serif';
  const label = `${src.name}  ${Math.round(src.w)}×${Math.round(src.h)}  @${Math.round(src.x)},${Math.round(src.y)}`;
  const tw = ctx.measureText(label).width + 10;
  const ly = src.y - 20 < 0 ? src.y + 6 : src.y - 20;
  ctx.fillStyle = 'rgba(15, 17, 19, 0.9)';
  ctx.fillRect(src.x, ly, tw, 18);
  ctx.fillStyle = '#e7e9ec';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, src.x + 5, ly + 9);
  ctx.restore();
}

/* ------------------------------------------------------------- main loop -- */

function ensureScratch() {
  const state = getState();
  if (!scratchA) {
    scratchA = document.createElement('canvas');
    scratchB = document.createElement('canvas');
  }
  if (scratchA.width !== state.resolution.w || scratchA.height !== state.resolution.h) {
    scratchA.width = scratchB.width = state.resolution.w;
    scratchA.height = scratchB.height = state.resolution.h;
  }
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function renderProgram(now) {
  const state = getState();
  const ctx = programCtx;
  const incoming = sceneAt(state.programSceneId);

  if (!transition.active) {
    drawScene(ctx, incoming, state, now);
    return;
  }

  const elapsed = now - transition.startedAt;
  const raw = transition.duration > 0 ? clamp(elapsed / transition.duration, 0, 1) : 1;
  const p = easeInOut(raw);
  const outgoing = sceneAt(transition.outgoingId);
  const { w, h } = state.resolution;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  const a = scratchA.getContext('2d');
  const b = scratchB.getContext('2d');
  drawScene(a, outgoing, state, now);
  drawScene(b, incoming, state, now);

  switch (transition.type) {
    case 'fade':
      ctx.globalAlpha = 1;
      ctx.drawImage(scratchA, 0, 0);
      ctx.globalAlpha = p;
      ctx.drawImage(scratchB, 0, 0);
      ctx.globalAlpha = 1;
      break;
    case 'move':
      ctx.drawImage(scratchA, -w * p, 0);
      ctx.drawImage(scratchB, w * (1 - p), 0);
      break;
    case 'slide':
      ctx.drawImage(scratchA, 0, 0);
      ctx.drawImage(scratchB, 0, h * (1 - p));
      break;
    default:
      ctx.drawImage(p < 1 ? scratchA : scratchB, 0, 0);
      break;
  }

  if (raw >= 1) transition.active = false;
}

export function initRenderer(preview, program) {
  previewCanvas = preview;
  programCanvas = program;
  previewCtx = preview.getContext('2d');
  programCtx = program.getContext('2d');

  ensureScratch();
  setupInteraction(previewCanvas);
  subscribe((state) => {
    ensureScratch();
    syncMedia(state);
    applyResolution(state);
  });
  syncMedia(getState());
  applyResolution(getState());
}

function applyResolution(state) {
  const { w, h } = state.resolution;
  if (previewCanvas.width !== w || previewCanvas.height !== h) {
    previewCanvas.width = w; previewCanvas.height = h;
    programCanvas.width = w; programCanvas.height = h;
  }
}

export function startRenderLoop(onStats) {
  const loop = (now) => {
    const state = getState();

    // preview
    const preview = previewScene();
    drawScene(previewCtx, preview, state, now);
    if (preview && state.selectedSourceId) drawSelection(previewCtx, preview, state);

    renderProgram(now);

    frames += 1;
    if (now - fpsStamp >= 1000) {
      fps = frames;
      frames = 0;
      fpsStamp = now;
      if (onStats) onStats(fps);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export function getFps() { return fps; }

export { previewCanvas as getPreviewCanvas, programCanvas as getProgramCanvas };
