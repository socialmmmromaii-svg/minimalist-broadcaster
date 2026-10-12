/**
 * ui.js — panels, properties, mixer, dialogs and toasts.
 *
 * Rendering is deliberately simple: every store change re-renders the lists
 * (they are tiny), while the properties form only rebuilds when the selection
 * changes so typing never loses focus. Meter values are updated in their own
 * rAF loop so they do not touch the store.
 */

import {
  getState, update, previewScene, selectedSource, updateSource,
  uid, defaultSource, typeLabel, resetState,
} from './store.js';
import { readLevel, readMasterLevel, levelToDb, resumeAudio } from './audio.js';
import { resumeMediaPlayback } from './renderer.js';

const $ = (id) => document.getElementById(id);
const AUDIO_TYPES = ['camera', 'display', 'video', 'audio'];
const FILE_TYPES = ['image', 'video', 'audio'];

let handlers = {};
let propsForId = undefined;
let mixerKey = '';
let lastPreviewId = undefined;

/* ------------------------------------------------------------------ util -- */

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function confirmSafe(message, fallback = false) {
  try { return window.confirm(message); } catch { return fallback; }
}

function withFocusRestored(container, fn) {
  const active = document.activeElement;
  const key = active && active.dataset ? active.dataset.fkey : null;
  fn();
  if (key) {
    try {
      const next = container.querySelector(`[data-fkey="${CSS.escape(key)}"]`);
      if (next && typeof next.focus === 'function') next.focus();
    } catch { /* CSS.escape missing — ignore */ }
  }
}

export function showToast(message, kind = 'info') {
  const host = $('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast--error' : kind === 'ok' ? ' toast--ok' : ''}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 4200);
  setTimeout(() => el.remove(), 4800);
}

/* ------------------------------------------------------------------ tabs -- */

function wireTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
  };
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(tab);
      let next = -1;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) { e.preventDefault(); select(tabs[next]); tabs[next].focus(); }
    });
  });
}

export function selectTab(panelId) {
  const tab = document.querySelector(`[role="tab"][aria-controls="${panelId}"]`);
  if (tab) tab.click();
}

/* ---------------------------------------------------------------- scenes -- */

function renderScenes(state) {
  const list = $('sceneList');
  if (!list) return;
  withFocusRestored(list, () => {
    list.innerHTML = '';
    state.scenes.forEach((scene, i) => {
      const isPreview = scene.id === state.previewSceneId;
      const isProgram = scene.id === state.programSceneId;
      const li = document.createElement('li');
      li.className = `item${isProgram ? ' is-program' : ''}${isPreview ? ' is-preview' : ''}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(isPreview));
      li.tabIndex = 0;
      li.dataset.sceneId = scene.id;
      li.dataset.fkey = `scene:${scene.id}`;
      li.innerHTML = `
        <span class="item__index" aria-hidden="true">${i + 1}</span>
        <span class="item__name" data-rename="${scene.id}" data-fkey="scene-name:${scene.id}">${escapeHtml(scene.name)}</span>
        <span class="item__type">${scene.sources.length} src</span>
        ${isProgram ? '<span class="item__tag item__tag--on-air">On air</span>' : ''}
        ${isPreview && !isProgram ? '<span class="item__tag item__tag--preview">Preview</span>' : ''}`;
      list.appendChild(li);
    });
  });
}

function renameScene(sceneId, span) {
  if (span.isContentEditable) return;
  const state = getState();
  const scene = state.scenes.find((s) => s.id === sceneId);
  if (!scene) return;
  const original = scene.name;
  span.contentEditable = 'plaintext-only';
  if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true'; // Firefox fallback
  span.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* selection is cosmetic */ }

  const finish = (commit) => {
    span.contentEditable = 'false';
    const value = (span.textContent || '').trim();
    span.removeEventListener('keydown', onKey);
    span.removeEventListener('blur', onBlur);
    if (commit && value && value !== original) {
      update((s) => {
        const target = s.scenes.find((sc) => sc.id === sceneId);
        if (target) target.name = value.slice(0, 60);
      });
    } else {
      span.textContent = original;
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  span.addEventListener('keydown', onKey);
  span.addEventListener('blur', onBlur);
}

function wireScenes() {
  const list = $('sceneList');

  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-scene-id]');
    if (!li) return;
    // while a scene is being renamed inline, clicks belong to the editor
    const nameEl = e.target.closest('[data-rename]');
    if (nameEl && nameEl.isContentEditable) return;
    selectPreviewScene(li.dataset.sceneId);
  });

  list.addEventListener('dblclick', (e) => {
    const span = e.target.closest('[data-rename]');
    if (span) renameScene(span.dataset.rename, span);
  });

  list.addEventListener('keydown', (e) => {
    const li = e.target.closest('[data-scene-id]');
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectPreviewScene(li.dataset.sceneId);
    }
    if (e.key === 'F2') {
      e.preventDefault();
      const span = li.querySelector('[data-rename]');
      if (span) renameScene(span.dataset.rename, span);
    }
  });

  $('btnAddScene').addEventListener('click', () => {
    update((s) => {
      const res = s.resolution;
      const scene = { id: uid('scene'), name: `Scene ${s.scenes.length + 1}`, sources: [defaultSource('color', res)] };
      s.scenes.push(scene);
      s.previewSceneId = scene.id;
      s.selectedSourceId = null;
    });
  });

  $('btnDupScene').addEventListener('click', () => {
    update((s) => {
      const src = s.scenes.find((sc) => sc.id === s.previewSceneId);
      if (!src) return;
      const clone = {
        id: uid('scene'),
        name: `${src.name} copy`,
        sources: src.sources.map((x) => ({ ...structuredClone(x), id: uid('src') })),
      };
      const idx = s.scenes.findIndex((sc) => sc.id === src.id);
      s.scenes.splice(idx + 1, 0, clone);
      s.previewSceneId = clone.id;
      s.selectedSourceId = null;
    });
  });

  $('btnRenScene').addEventListener('click', () => {
    const state = getState();
    const span = document.querySelector(`[data-rename="${state.previewSceneId}"]`);
    if (span) renameScene(state.previewSceneId, span);
  });

  $('btnDelScene').addEventListener('click', () => {
    const state = getState();
    if (state.scenes.length <= 1) {
      showToast('The studio needs at least one scene', 'error');
      return;
    }
    const scene = state.scenes.find((s) => s.id === state.previewSceneId);
    if (!confirmSafe(`Delete scene “${scene ? scene.name : ''}” and its ${scene ? scene.sources.length : 0} source(s)?`)) return;
    update((s) => {
      const idx = s.scenes.findIndex((sc) => sc.id === s.previewSceneId);
      if (idx < 0 || s.scenes.length <= 1) return;
      s.scenes.splice(idx, 1);
      const next = s.scenes[Math.min(idx, s.scenes.length - 1)];
      s.previewSceneId = next.id;
      if (!s.scenes.some((sc) => sc.id === s.programSceneId)) s.programSceneId = next.id;
      s.selectedSourceId = null;
    });
  });
}

function selectPreviewScene(sceneId) {
  update((s) => {
    if (s.previewSceneId === sceneId) return;
    s.previewSceneId = sceneId;
    s.selectedSourceId = null;
  });
}

/* --------------------------------------------------------------- sources -- */

function renderSources(state) {
  const list = $('sourceList');
  if (!list) return;
  const scene = state.scenes.find((s) => s.id === state.previewSceneId);
  const sources = scene ? [...scene.sources].reverse() : [];

  withFocusRestored(list, () => {
    list.innerHTML = '';
    if (!sources.length) {
      const li = document.createElement('li');
      li.className = 'empty-state';
      li.style.border = 'none';
      li.innerHTML = '<p class="empty-state__title">No sources yet</p>'
        + '<p class="empty-state__text">Add a screen capture, camera, lower third or image from the toolbar above.</p>';
      list.appendChild(li);
      return;
    }
    for (const src of sources) {
      const li = document.createElement('li');
      li.className = 'item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(src.id === state.selectedSourceId));
      li.tabIndex = 0;
      li.dataset.sourceId = src.id;
      li.dataset.fkey = `source:${src.id}`;
      li.innerHTML = `
        <button class="icon-btn" data-act="vis" data-fkey="vis:${src.id}"
                aria-pressed="${src.visible}" title="${src.visible ? 'Hide' : 'Show'} ${escapeHtml(src.name)}"
                aria-label="${src.visible ? 'Hide' : 'Show'} ${escapeHtml(src.name)}">${src.visible ? '◉' : '○'}</button>
        <span class="item__name">${escapeHtml(src.name)}</span>
        <span class="item__type">${escapeHtml(typeLabel(src.type))}</span>
        ${src.muted ? '<span class="item__tag">muted</span>' : ''}`;
      list.appendChild(li);
    }
  });
}

function wireSources() {
  const list = $('sourceList');

  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-source-id]');
    if (!li) return;
    const id = li.dataset.sourceId;
    const visBtn = e.target.closest('[data-act="vis"]');
    if (visBtn) {
      updateSource(id, (src) => { src.visible = !src.visible; });
      return;
    }
    update((s) => { s.selectedSourceId = id; });
  });

  list.addEventListener('keydown', (e) => {
    const li = e.target.closest('[data-source-id]');
    if (!li) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      update((s) => { s.selectedSourceId = li.dataset.sourceId; });
    }
  });

  $('btnAddSource').addEventListener('click', () => {
    const type = $('newSourceType').value;
    if (FILE_TYPES.includes(type)) {
      const input = $('sourceFile');
      input.accept = type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : 'audio/*';
      input.value = '';
      input.dataset.type = type;
      input.click();
      return;
    }
    addSource(type);
  });

  $('sourceFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    const type = e.target.dataset.type;
    const replaceId = e.target.dataset.replaceId || null;
    e.target.dataset.replaceId = '';
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      showToast('That file is larger than 12 MB — pick something smaller', 'error');
      return;
    }

    const apply = (src, sessionOnly) => {
      if (replaceId) {
        updateSource(replaceId, (target) => {
          target.props.src = src;
          target.props.sessionOnly = !!sessionOnly;
        });
        renderProps(false);
        showToast('File replaced', 'ok');
        return;
      }
      addSource(type, { src, ...(type === 'video' ? { loop: true, muted: true } : {}) }, sessionOnly);
    };

    if (type === 'image') {
      const reader = new FileReader();
      reader.onload = () => apply(reader.result, reader.result.length > 1_500_000);
      reader.onerror = () => showToast('Could not read that image', 'error');
      reader.readAsDataURL(file);
    } else {
      apply(URL.createObjectURL(file), true);
      showToast('File sources last for this session — the scene layout persists', 'info');
    }
  });

  $('btnSrcUp').addEventListener('click', () => moveSelectedSource(-1));
  $('btnSrcDown').addEventListener('click', () => moveSelectedSource(1));
  $('btnDelSource').addEventListener('click', deleteSelectedSource);
}

function addSource(type, propsExtra = {}, sessionOnly = false) {
  let created = null;
  update((s) => {
    const scene = s.scenes.find((sc) => sc.id === s.previewSceneId);
    if (!scene) return;
    const src = defaultSource(type, s.resolution);
    src.props = { ...src.props, ...propsExtra };
    if (sessionOnly) src.props.sessionOnly = true;
    if (type === 'clock') src.name = `Clock ${scene.sources.filter((x) => x.type === 'clock').length + 1}`;
    if (type === 'text' || type === 'lower-third') {
      const n = scene.sources.filter((x) => x.type === type).length;
      if (n > 0) src.name = `${src.name} ${n + 1}`;
    }
    scene.sources.push(src);
    s.selectedSourceId = src.id;
    created = src.id;
  });
  if (created) {
    renderProps(false);
    selectTab('panel-sources');
  }
  return created;
}

function moveSelectedSource(direction) {
  const id = getState().selectedSourceId;
  if (!id) { showToast('Select a source first', 'error'); return; }
  update((s) => {
    const scene = s.scenes.find((sc) => sc.id === s.previewSceneId);
    if (!scene) return;
    const i = scene.sources.findIndex((x) => x.id === id);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= scene.sources.length) return;
    [scene.sources[i], scene.sources[j]] = [scene.sources[j], scene.sources[i]];
  });
}

function deleteSelectedSource() {
  const id = getState().selectedSourceId;
  if (!id) { showToast('Select a source first', 'error'); return; }
  update((s) => {
    const scene = s.scenes.find((sc) => sc.id === s.previewSceneId);
    if (!scene) return;
    scene.sources = scene.sources.filter((x) => x.id !== id);
    if (s.selectedSourceId === id) s.selectedSourceId = null;
  });
}

/* ---------------------------------------------------------------- mixer -- */

function audioSourcesOfPreview(state) {
  const scene = state.scenes.find((s) => s.id === state.previewSceneId);
  if (!scene) return [];
  return scene.sources.filter((s) => AUDIO_TYPES.includes(s.type));
}

function renderMixer(state) {
  const host = $('mixerList');
  if (!host) return;
  const sources = audioSourcesOfPreview(state);
  const key = `${state.previewSceneId}|${sources.map((s) => s.id).join(',')}|${sources.map((s) => s.name).join(',')}`;

  if (key !== mixerKey) {
    mixerKey = key;
    host.innerHTML = '';
    for (const src of sources) host.appendChild(mixRow(src.id, src.name, typeLabel(src.type), src.volume, src.muted));
    host.appendChild(mixRow('master', 'Master', 'Program output', state.mixer.master.gain, state.mixer.master.mute, true));
    return;
  }

  // same structure — refresh control values that are not being edited
  for (const src of sources) syncMixRow(src.id, src.volume, src.muted);
  syncMixRow('master', state.mixer.master.gain, state.mixer.master.mute);
}

function mixRow(id, name, sub, volume, muted, isMaster = false) {
  const div = document.createElement('div');
  div.className = `mix-row${isMaster ? ' mix-row--master' : ''}`;
  div.dataset.mix = id;
  div.innerHTML = `
    <div class="mix-row__name">${escapeHtml(name)}<span class="mix-row__sub">${escapeHtml(sub)}</span></div>
    <div class="meter" role="meter" aria-label="${escapeHtml(name)} level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <span class="meter__fill" data-fill="${id}"></span>
    </div>
    <span class="mix-row__db" data-db="${id}">-∞ dB</span>
    <input type="range" min="0" max="1.5" step="0.01" value="${volume}" data-vol="${id}"
           aria-label="Volume for ${escapeHtml(name)}" title="Volume ${Math.round(volume * 100)}%" />
    <button type="button" class="btn btn--sm mix-row__mute" data-mute="${id}"
            aria-pressed="${muted}" aria-label="${muted ? 'Unmute' : 'Mute'} ${escapeHtml(name)}">Mute</button>`;
  return div;
}

function syncMixRow(id, volume, muted) {
  const row = document.querySelector(`[data-mix="${id}"]`);
  if (!row) return;
  const slider = row.querySelector(`[data-vol="${id}"]`);
  if (slider && document.activeElement !== slider) {
    slider.value = String(volume);
    slider.title = `Volume ${Math.round(volume * 100)}%`;
  }
  const mute = row.querySelector(`[data-mute="${id}"]`);
  if (mute) {
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} ${row.querySelector('.mix-row__name').firstChild.textContent.trim()}`);
  }
}

function wireMixer() {
  const host = $('mixerList');

  host.addEventListener('input', (e) => {
    const slider = e.target.closest('[data-vol]');
    if (!slider) return;
    const id = slider.dataset.vol;
    const value = Number(slider.value);
    if (id === 'master') {
      update((s) => { s.mixer.master.gain = value; });
    } else {
      updateSource(id, (src) => { src.volume = value; });
    }
  });

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mute]');
    if (!btn) return;
    const id = btn.dataset.mute;
    if (id === 'master') {
      update((s) => { s.mixer.master.mute = !s.mixer.master.mute; });
    } else {
      updateSource(id, (src) => { src.muted = !src.muted; });
    }
  });
}

function startMeterLoop() {
  const fmt = (level) => (level <= 0.0015 ? '-∞ dB' : `${levelToDb(level).toFixed(1)} dB`);

  const tick = () => {
    const panel = $('panel-mixer');
    if (panel && !panel.hidden) {
      const state = getState();
      const fill = (id, level) => {
        const bar = document.querySelector(`[data-fill="${id}"]`);
        const db = document.querySelector(`[data-db="${id}"]`);
        const pct = Math.round(level * 100);
        if (bar) bar.style.width = `${pct}%`;
        if (db) db.textContent = fmt(level);
        const meter = bar && bar.parentElement;
        if (meter) meter.setAttribute('aria-valuenow', String(pct));
      };
      for (const src of audioSourcesOfPreview(state)) fill(src.id, readLevel(src.id));
      fill('master', readMasterLevel());
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------ properties -- */

const NUMERIC = ['x', 'y', 'w', 'h'];

function buildPropsForm(src) {
  const form = $('propsForm');
  const empty = $('propsEmpty');
  const kind = $('propsKind');
  if (!form) return;

  if (!src) {
    form.hidden = true;
    form.innerHTML = '';
    if (empty) empty.hidden = false;
    if (kind) kind.textContent = 'Nothing selected';
    return;
  }

  if (empty) empty.hidden = true;
  form.hidden = false;
  if (kind) kind.textContent = typeLabel(src.type);

  const p = src.props || {};
  const sections = [];

  sections.push(`
    <label class="field">
      <span class="field__label">Name</span>
      <input class="input" type="text" data-field="name" value="${escapeHtml(src.name)}" maxlength="60" />
    </label>
    <div class="props-grid">
      <label class="field"><span class="field__label">X</span>
        <input class="input" type="number" step="1" data-field="x" value="${Math.round(src.x)}" /></label>
      <label class="field"><span class="field__label">Y</span>
        <input class="input" type="number" step="1" data-field="y" value="${Math.round(src.y)}" /></label>
      <label class="field"><span class="field__label">Width</span>
        <input class="input" type="number" step="1" min="24" data-field="w" value="${Math.round(src.w)}" /></label>
      <label class="field"><span class="field__label">Height</span>
        <input class="input" type="number" step="1" min="24" data-field="h" value="${Math.round(src.h)}" /></label>
    </div>
    <label class="row"><input type="checkbox" data-field="visible" ${src.visible ? 'checked' : ''} /> Visible on canvas</label>`);

  switch (src.type) {
    case 'color':
      sections.push(colorField('Background colour', 'color', p.color || '#10151b'));
      break;
    case 'text':
      sections.push(`
        <label class="field"><span class="field__label">Text</span>
          <input class="input" type="text" data-prop="text" value="${escapeHtml(p.text || '')}" maxlength="140" /></label>
        <div class="props-grid">
          ${colorField('Colour', 'color', p.color || '#ffffff')}
          <label class="field"><span class="field__label">Size (px)</span>
            <input class="input" type="number" min="8" max="400" data-prop="fontSize" value="${p.fontSize || 48}" /></label>
        </div>
        <div class="props-grid">
          <label class="field"><span class="field__label">Align</span>
            <select class="input" data-prop="align">
              <option value="left" ${p.align === 'left' ? 'selected' : ''}>Left</option>
              <option value="center" ${!p.align || p.align === 'center' ? 'selected' : ''}>Centre</option>
              <option value="right" ${p.align === 'right' ? 'selected' : ''}>Right</option>
            </select></label>
          <label class="row"><input type="checkbox" data-prop="bold" ${p.bold !== false ? 'checked' : ''} /> Bold</label>
        </div>`);
      break;
    case 'lower-third':
      sections.push(`
        <label class="field"><span class="field__label">Headline</span>
          <input class="input" type="text" data-prop="headline" value="${escapeHtml(p.headline || '')}" maxlength="80" /></label>
        <label class="field"><span class="field__label">Subline</span>
          <input class="input" type="text" data-prop="subline" value="${escapeHtml(p.subline || '')}" maxlength="80" /></label>
        <div class="props-grid">
          ${colorField('Accent', 'accent', p.accent || '#35c4b5')}
          <label class="field"><span class="field__label">Size (px)</span>
            <input class="input" type="number" min="8" max="200" data-prop="fontSize" value="${p.fontSize || 34}" /></label>
        </div>`);
      break;
    case 'clock':
      sections.push(`
        <div class="props-grid">
          ${colorField('Colour', 'color', p.color || '#ffffff')}
          <label class="row"><input type="checkbox" data-prop="format24" ${p.format24 !== false ? 'checked' : ''} /> 24-hour</label>
        </div>`);
      break;
    case 'camera':
    case 'display':
      sections.push(`
        <label class="row"><input type="checkbox" data-prop="withAudio" ${p.withAudio ? 'checked' : ''} />
          ${src.type === 'camera' ? 'Capture device audio' : 'Capture system audio'}</label>
        <p class="muted">${src.type === 'camera'
          ? 'Permission is requested once per source. If it was denied, remove this source and add it again.'
          : 'Your browser picks the screen or window when the source is created.'}</p>`);
      break;
    case 'video':
      sections.push(`
        <div class="props-grid">
          <label class="row"><input type="checkbox" data-prop="loop" ${p.loop ? 'checked' : ''} /> Loop</label>
          <label class="row"><input type="checkbox" data-prop="muted" ${p.muted ? 'checked' : ''} /> Audio enabled</label>
        </div>
        <button type="button" class="btn btn--sm" data-act="replace">Replace file…</button>`);
      break;
    case 'image':
      sections.push('<button type="button" class="btn btn--sm" data-act="replace">Replace image…</button>');
      break;
    case 'audio':
      sections.push('<button type="button" class="btn btn--sm" data-act="replace">Replace audio…</button>');
      break;
    default:
      break;
  }

  form.innerHTML = sections.join('');
  wirePropsForm(src);
}

function colorField(label, prop, value) {
  return `<label class="field"><span class="field__label">${label}</span>
    <input class="input" type="color" data-prop="${prop}" value="${escapeHtml(value)}" /></label>`;
}

function wirePropsForm(src) {
  const form = $('propsForm');
  const id = src.id;

  form.oninput = (e) => {
    const el = e.target;
    const field = el.dataset.field;
    const prop = el.dataset.prop;
    if (!field && !prop) return;

    if (field === 'visible') {
      updateSource(id, (s) => { s.visible = el.checked; });
      return;
    }
    if (field === 'name') {
      updateSource(id, (s) => { s.name = el.value.slice(0, 60) || s.name; });
      return;
    }
    if (NUMERIC.includes(field)) {
      const value = Number(el.value);
      if (!Number.isFinite(value)) return;
      updateSource(id, (s) => {
        if (field === 'w' || field === 'h') s[field] = Math.max(24, Math.round(value));
        else s[field] = Math.round(value);
      });
      return;
    }
    if (!prop) return;

    const checkbox = el.type === 'checkbox';
    const numeric = el.type === 'number';
    const value = checkbox ? el.checked : numeric ? Number(el.value) : el.value;

    updateSource(id, (s) => {
      if (prop === 'muted' && s.type === 'video') { s.props.muted = value; return; }
      s.props[prop] = value;
    });
  };

  form.onchange = (e) => {
    if (e.target.type === 'checkbox') form.oninput(e);
  };

  form.onclick = (e) => {
    const btn = e.target.closest('[data-act="replace"]');
    if (!btn) return;
    const type = getState().selectedSourceId ? (previewScene().sources.find((s) => s.id === id) || {}).type : null;
    const input = $('sourceFile');
    input.dataset.type = type || 'image';
    input.dataset.replaceId = id;
    input.accept = type === 'video' ? 'video/*' : type === 'audio' ? 'audio/*' : 'image/*';
    input.value = '';
    input.click();
  };
}

export function renderProps(numbersOnly = false) {
  const src = selectedSource();
  const id = src ? src.id : null;
  if (id !== propsForId || !numbersOnly) {
    propsForId = id;
    buildPropsForm(src);
    return;
  }
  if (!src) return;
  for (const key of NUMERIC) {
    const input = document.querySelector(`[data-field="${key}"]`);
    if (input && document.activeElement !== input) input.value = String(Math.round(src[key]));
  }
}

function renderPropsIfSelectionChanged(state) {
  const id = state.selectedSourceId || null;
  renderProps(id === propsForId); // equal → numbers only; changed → rebuild
}

/* ----------------------------------------------------------- lower thirds -- */

function wireLowerThirds() {
  const headline = $('ltHeadline');
  const subline = $('ltSubline');

  const syncToSelected = () => {
    const src = selectedSource();
    if (!src || src.type !== 'lower-third') return;
    updateSource(src.id, (s) => {
      s.props.headline = headline.value;
      s.props.subline = subline.value;
    });
    renderProps(false);
  };
  headline.addEventListener('input', syncToSelected);
  subline.addEventListener('input', syncToSelected);

  $('btnAddLowerThird').addEventListener('click', () => {
    addSource('lower-third', {
      headline: headline.value.trim() || 'Jane Doe',
      subline: subline.value.trim() || 'Live from the studio',
    });
  });

  $('btnAddText').addEventListener('click', () => {
    addSource('text', { text: headline.value.trim() || 'Live now' });
  });
}

/* --------------------------------------------------------------- settings -- */

function wireSettings() {
  const dialog = $('settingsDialog');
  const open = () => {
    const state = getState();
    $('setResolution').value = `${state.resolution.w}x${state.resolution.h}`;
    $('setFps').value = String(state.fps);
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  };
  $('btnSettings').addEventListener('click', open);

  $('setResolution').addEventListener('change', (e) => {
    const [w, h] = e.target.value.split('x').map(Number);
    update((s) => {
      const sx = w / s.resolution.w;
      const sy = h / s.resolution.h;
      const sf = (sx + sy) / 2;
      for (const scene of s.scenes) {
        for (const src of scene.sources) {
          src.x = Math.round(src.x * sx);
          src.y = Math.round(src.y * sy);
          src.w = Math.round(src.w * sx);
          src.h = Math.round(src.h * sy);
          if (src.props.fontSize) src.props.fontSize = Math.max(8, Math.round(src.props.fontSize * sf));
        }
      }
      s.resolution = { w, h };
    });
    showToast(`Canvas set to ${w}×${h}`, 'ok');
  });

  $('setFps').addEventListener('change', (e) => {
    update((s) => { s.fps = Number(e.target.value); });
  });

  $('btnResetData').addEventListener('click', () => {
    if (!confirmSafe('Reset scenes, sources and mixer levels to the factory layout?')) return;
    resetState();
    propsForId = undefined;
    mixerKey = '';
    showToast('Layout reset', 'ok');
    try { $('settingsDialog').close(); } catch { $('settingsDialog').removeAttribute('open'); }
  });
}

/* ---------------------------------------------------------------- stream -- */

function wireStreamForm() {
  $('streamForm').addEventListener('submit', (e) => {
    e.preventDefault();
    update((s) => {
      s.stream = {
        whipUrl: $('whipUrl').value.trim(),
        whipToken: $('whipToken').value.trim(),
        rtmpUrl: $('rtmpUrl').value.trim(),
        rtmpKey: $('rtmpKey').value.trim(),
      };
    });
    $('streamSavedNote').textContent = 'Saved';
    setTimeout(() => { $('streamSavedNote').textContent = ''; }, 2500);
    showToast('Destination saved', 'ok');
  });
}

function renderStreamFields(state) {
  const pairs = [
    ['whipUrl', state.stream.whipUrl],
    ['whipToken', state.stream.whipToken],
    ['rtmpUrl', state.stream.rtmpUrl],
    ['rtmpKey', state.stream.rtmpKey],
  ];
  for (const [id, value] of pairs) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = value || '';
  }
}

/* ----------------------------------------------------------------- chrome -- */

function renderHeaders(state) {
  const preview = state.scenes.find((s) => s.id === state.previewSceneId);
  const program = state.scenes.find((s) => s.id === state.programSceneId);
  const name = (s) => (s ? s.name : '—');

  const previewName = $('previewSceneName');
  if (previewName && previewName.textContent !== name(preview)) previewName.textContent = name(preview);
  const programName = $('programSceneName');
  if (programName && programName.textContent !== name(program)) programName.textContent = name(program);

  const meta = `${state.resolution.w}×${state.resolution.h} · ${state.fps} fps`;
  if ($('previewMeta')) $('previewMeta').textContent = meta;
  if ($('programMeta')) $('programMeta').textContent = 'ON AIR';
  if ($('statusRes')) $('statusRes').textContent = `${state.resolution.w}×${state.resolution.h}`;

  const hint = $('previewHint');
  if (hint) hint.hidden = !(preview && preview.sources.length === 0);
}

export function renderUI(state) {
  renderHeaders(state);
  renderScenes(state);
  renderSources(state);
  renderMixer(state);
  renderStreamFields(state);
  renderPropsIfSelectionChanged(state);
}

/* --------------------------------------------------------------- controls -- */

export function wireControls(h) {
  handlers = h;
  wireTabs();
  wireScenes();
  wireSources();
  wireMixer();
  wireLowerThirds();
  wireSettings();
  wireStreamForm();

  $('transitionType').addEventListener('change', (e) => {
    update((s) => { s.transition.type = e.target.value; });
  });
  $('transitionDuration').addEventListener('input', (e) => {
    const value = Number(e.target.value);
    $('transitionDurationValue').textContent = `${value} ms`;
    update((s) => { s.transition.duration = value; });
  });

  $('btnTake').addEventListener('click', () => handlers.take(false));
  $('btnCut').addEventListener('click', () => handlers.take(true));
  $('btnSwap').addEventListener('click', () => handlers.swap());
  $('btnRecord').addEventListener('click', () => handlers.toggleRecord());
  $('btnStream').addEventListener('click', () => handlers.toggleStream());

  const unlockMedia = () => {
    resumeAudio();
    resumeMediaPlayback();
  };
  document.addEventListener('pointerdown', unlockMedia, true);
  document.addEventListener('keydown', unlockMedia, true);

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'
      || t.isContentEditable || t.tagName === 'DIALOG');
    if (typing) return;
    const dialog = $('settingsDialog');
    if (dialog && dialog.open && e.key !== 's') return;

    if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); handlers.take(true); return; }
    if (e.key === ' ') { e.preventDefault(); handlers.take(false); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); handlers.toggleRecord(); return; }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); $('btnSettings').click(); return; }
    if (e.key === 'Delete') { e.preventDefault(); deleteSelectedSource(); }
  });

  startMeterLoop();
}

/* ---------------------------------------------------------- status helpers -- */

export function setRecordingUI(active) {
  const chip = $('recChip');
  const idle = $('idleChip');
  const btn = $('btnRecord');
  if (chip) chip.hidden = !active;
  if (idle) idle.hidden = active;
  if (btn) {
    btn.setAttribute('aria-pressed', String(active));
    btn.innerHTML = `<span class="btn__icon" aria-hidden="true">${active ? '■' : '●'}</span> ${active ? 'Stop' : 'Record'}`;
  }
}

export function setStreamingUI(active) {
  const chip = $('liveChip');
  const btn = $('btnStream');
  if (chip) chip.hidden = !active;
  if (btn) {
    btn.setAttribute('aria-pressed', String(active));
    btn.innerHTML = `<span class="btn__icon" aria-hidden="true">▲</span> ${active ? 'Stop' : 'Stream'}`;
  }
}

export function setRecordingTime(ms) {
  const el = $('recTimer');
  if (!el) return;
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  el.textContent = `${mm}:${ss}`;
}

export function setFpsStatus(fps) {
  const el = $('statusFps');
  if (el) el.textContent = `${fps} fps`;
}
