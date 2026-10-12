/**
 * store.js — single source of truth for the studio.
 *
 * State shape (persisted to localStorage):
 * {
 *   version, resolution:{w,h}, fps, transition:{type,duration},
 *   previewSceneId, programSceneId,
 *   scenes: [{ id, name, sources:[source] }],
 *   mixer: { master:{gain,mute} },
 *   stream: { whipUrl, whipToken, rtmpUrl, rtmpKey },
 *   selectedSourceId
 * }
 *
 * source = {
 *   id, type, name, visible,
 *   x, y, w, h,            // virtual-space transform (0..resW / 0..resH)
 *   volume, muted,          // audio-capable sources
 *   props: {...}            // type specific (text, color, src, ...)
 * }
 */

export const STORAGE_KEY = 'minimalist-broadcaster:v1';

let counter = 0;
export function uid(prefix = 's') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------------------------------- defaults --------------------------------- */

export function defaultSource(type, res) {
  const base = {
    id: uid('src'),
    type,
    name: typeLabel(type),
    visible: true,
    x: Math.round(res.w * 0.15),
    y: Math.round(res.h * 0.15),
    w: Math.round(res.w * 0.7),
    h: Math.round(res.h * 0.5),
    volume: 1,
    muted: false,
    props: {},
  };

  switch (type) {
    case 'color':
      base.name = 'Background';
      base.x = 0; base.y = 0; base.w = res.w; base.h = res.h;
      base.props = { color: '#10151b' };
      break;
    case 'text':
      base.name = 'Title text';
      base.h = Math.round(res.h * 0.18);
      base.props = { text: 'Live now', fontSize: Math.round(res.h / 9), color: '#ffffff', align: 'center', bold: true };
      break;
    case 'lower-third':
      base.name = 'Lower third';
      base.y = Math.round(res.h * 0.72);
      base.h = Math.round(res.h * 0.16);
      base.props = {
        headline: 'Jane Doe',
        subline: 'Live from the studio',
        accent: '#35c4b5',
        fontSize: Math.round(res.h / 24),
      };
      break;
    case 'clock':
      base.name = 'Clock';
      base.w = Math.round(res.w * 0.16);
      base.h = Math.round(res.h * 0.1);
      base.x = res.w - base.w - Math.round(res.w * 0.03);
      base.y = Math.round(res.h * 0.04);
      base.props = { color: '#ffffff', format24: true };
      break;
    case 'image':
      base.name = 'Image';
      base.w = Math.round(res.w * 0.4);
      base.h = Math.round(res.h * 0.4);
      break;
    case 'video':
      base.name = 'Video';
      base.w = Math.round(res.w * 0.5);
      base.h = Math.round(res.h * 0.5);
      base.props = { loop: true, muted: true, autoplay: true };
      break;
    case 'audio':
      base.name = 'Audio';
      base.w = 240; base.h = 64;
      base.y = res.h - 120;
      break;
    case 'camera':
      base.name = 'Camera';
      base.w = Math.round(res.w * 0.34);
      base.h = Math.round(res.h * 0.34);
      base.x = res.w - base.w - Math.round(res.w * 0.03);
      base.y = res.h - base.h - Math.round(res.h * 0.05);
      base.props = { withAudio: true };
      break;
    case 'display':
      base.name = 'Screen capture';
      base.x = 0; base.y = 0; base.w = res.w; base.h = res.h;
      base.props = { withAudio: false };
      break;
    default:
      break;
  }
  return base;
}

export function typeLabel(type) {
  return {
    camera: 'Camera',
    display: 'Screen capture',
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    text: 'Text',
    'lower-third': 'Lower third',
    clock: 'Clock',
    color: 'Color',
  }[type] || 'Source';
}

function seedState() {
  const res = { w: 1280, h: 720 };
  const intro = {
    id: uid('scene'),
    name: 'Intro',
    sources: [
      defaultSource('color', res),
      defaultSource('lower-third', res),
      defaultSource('clock', res),
    ],
  };
  const brb = {
    id: uid('scene'),
    name: 'Be right back',
    sources: [
      { ...defaultSource('color', res), props: { color: '#0b0e12' } },
      { ...defaultSource('text', res), props: { text: 'Be right back', fontSize: Math.round(res.h / 8), color: '#e7e9ec', align: 'center', bold: true } },
    ],
  };
  return {
    version: 1,
    resolution: res,
    fps: 30,
    transition: { type: 'fade', duration: 400 },
    scenes: [intro, brb],
    previewSceneId: intro.id,
    programSceneId: intro.id,
    mixer: { master: { gain: 1, mute: false } },
    stream: { whipUrl: '', whipToken: '', rtmpUrl: '', rtmpKey: '' },
    selectedSourceId: null,
  };
}

/* ---------------------------------- store ----------------------------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.scenes)) return seedState();
    if (parsed.scenes.length === 0) return seedState();
    // blob: URLs from file picks only live for one session — drop the dead
    // references so the UI reports “No media file” instead of waiting forever
    for (const scene of parsed.scenes) {
      for (const src of scene.sources || []) {
        if (src.props && typeof src.props.src === 'string' && src.props.src.startsWith('blob:')) {
          delete src.props.src;
          src.props.sessionOnly = true;
        }
      }
    }
    return parsed;
  } catch {
    return seedState();
  }
}

let state = load();
const listeners = new Set();
let saveTimer = 0;

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('store listener failed', err);
    }
  }
}

/** Mutate state, persist (debounced) and notify subscribers. */
export function update(mutator, { persist = true } = {}) {
  mutator(state);
  if (persist) scheduleSave();
  emit();
}

/** Replace whole state (used by settings / reset). */
export function replaceState(next, { persist = true } = {}) {
  state = next;
  if (persist) scheduleSave();
  emit();
}

export function scheduleSave() {
  const el = document.getElementById('statusSaved');
  if (el) {
    el.textContent = 'Saving…';
    el.classList.add('is-saving');
    el.classList.remove('is-saved');
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (el) {
        el.textContent = 'Saved';
        el.classList.remove('is-saving');
        el.classList.add('is-saved');
      }
    } catch (err) {
      console.error('persist failed', err);
      if (el) el.textContent = 'Not saved';
    }
  }, 250);
}

export function resetState() {
  replaceState(seedState());
}

/* --------------------------------- helpers ---------------------------------- */

export function sceneById(id) {
  return state.scenes.find((s) => s.id === id) || null;
}

export function previewScene() {
  return sceneById(state.previewSceneId) || state.scenes[0] || null;
}

export function programScene() {
  return sceneById(state.programSceneId) || state.scenes[0] || null;
}

export function selectedSource() {
  const scene = previewScene();
  if (!scene || !state.selectedSourceId) return null;
  return scene.sources.find((s) => s.id === state.selectedSourceId) || null;
}

export function updateSource(sourceId, mutator) {
  update((s) => {
    const scene = s.scenes.find((sc) => sc.id === s.previewSceneId);
    const src = scene && scene.sources.find((x) => x.id === sourceId);
    if (src) mutator(src, scene);
  });
}
