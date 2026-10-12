/**
 * audio.js — the mixer.
 *
 * Signal flow per source:
 *   camera/screen  → MediaStreamSource ─┐
 *   video/audio     → MediaElementSource ┤
 *                                        ├→ volume gain → analyser (meter, pre-mute)
 *                                        └→ volume gain → mute gain → master gain
 *                                                                   ├→ speakers
 *                                                                   └→ stream/recording bus
 *
 * The AudioContext starts suspended (browser autoplay policy) and is resumed
 * on the first user gesture.
 */

import { getMedia } from './renderer.js';

let ctx = null;
let masterGain = null;
let masterMute = null;
let masterAnalyser = null;
let streamDest = null;

const nodes = new Map();            // sourceId -> node
const elementChains = new WeakMap(); // media element -> persistent audio chain

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    console.warn('Web Audio unavailable in this browser');
    return null;
  }
  ctx = new AC();
  masterGain = ctx.createGain();
  masterMute = ctx.createGain();
  masterAnalyser = ctx.createAnalyser();
  masterAnalyser.fftSize = 1024;
  streamDest = ctx.createMediaStreamDestination();

  masterGain.connect(masterMute);
  masterMute.connect(masterAnalyser);
  masterMute.connect(ctx.destination);
  masterMute.connect(streamDest);
  return ctx;
}

/** Call from a user gesture so meters and audio actually run. */
export function resumeAudio() {
  if (!ensureContext()) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

const AUDIO_TYPES = ['camera', 'display', 'video', 'audio'];

function hasAudio(kind, entry, src) {
  if (!entry) return false;
  if (kind === 'camera' || kind === 'display') {
    return !!(entry.stream && entry.stream.getAudioTracks().length);
  }
  if (kind === 'video') return src.props.muted !== true && !!entry.el;
  if (kind === 'audio') return !!entry.el;
  return false;
}

function chainFor(el) {
  let chain = elementChains.get(el);
  if (chain) {
    // re-arm a previously disconnected chain (source re-added after removal)
    try { chain.input.connect(chain.gain); } catch { /* already connected */ }
    return chain;
  }
  const input = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const muteGain = ctx.createGain();
  input.connect(gain);
  gain.connect(analyser);
  gain.connect(muteGain);
  muteGain.connect(masterGain);
  chain = { input, gain, analyser, muteGain };
  elementChains.set(el, chain);
  return chain;
}

function buildStreamChain(stream) {
  const input = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const muteGain = ctx.createGain();
  input.connect(gain);
  gain.connect(analyser);
  gain.connect(muteGain);
  muteGain.connect(masterGain);
  return { input, gain, analyser, muteGain };
}

function buildNode(id, kind, entry, src) {
  if (!ensureContext()) return null;
  try {
    const isStream = kind === 'camera' || kind === 'display';
    const chain = isStream ? buildStreamChain(entry.stream) : chainFor(entry.el);
    const node = {
      kind,
      el: isStream ? null : entry.el,
      stream: isStream ? entry.stream : null,
      chain,
      volume: null,
      muted: null,
    };
    nodes.set(id, node);
    return node;
  } catch (err) {
    console.warn('audio node failed for', id, err);
    return null;
  }
}

function destroyNode(id) {
  const node = nodes.get(id);
  if (!node) return;
  try { node.chain.input.disconnect(); } catch { /* ignore */ }
  nodes.delete(id);
}

/**
 * Reconcile mixer nodes with state. Audio-capable sources: camera and screen
 * capture with an audio track, plus video (unmuted) and audio-file sources.
 */
export function syncAudio(state) {
  if (!ensureContext()) return;

  const wanted = new Map();
  for (const scene of state.scenes) {
    for (const src of scene.sources) {
      if (!AUDIO_TYPES.includes(src.type)) continue;
      const entry = getMedia(src.id);
      if (!entry || entry instanceof Promise) continue;
      if (!hasAudio(src.type, entry, src)) continue;
      if (!wanted.has(src.id)) wanted.set(src.id, { kind: src.type, entry, src });
    }
  }

  for (const id of [...nodes.keys()]) {
    if (!wanted.has(id)) destroyNode(id);
  }

  for (const [id, { kind, entry, src }] of wanted) {
    let node = nodes.get(id);
    if (node) {
      const mismatch = (node.el && entry.el && node.el !== entry.el) ||
        (node.stream && entry.stream && node.stream !== entry.stream);
      if (mismatch) { destroyNode(id); node = null; }
    }
    if (!node) node = buildNode(id, kind, entry, src);
    if (!node) continue;

    // element-level "source has audio enabled" follows the source property
    if (node.el) {
      const wantMuted = src.props.muted === true;
      if (node.el.muted !== wantMuted) node.el.muted = wantMuted;
    }

    if (node.volume !== src.volume) {
      node.chain.gain.gain.value = Number(src.volume) || 0;
      node.volume = src.volume;
    }
    const muted = !!src.muted;
    if (node.muted !== muted) {
      node.chain.muteGain.gain.value = muted ? 0 : 1;
      node.muted = muted;
    }
  }
}

export function setMaster(gain, mute) {
  if (!ensureContext()) return;
  masterGain.gain.value = Number(gain);
  masterMute.gain.value = mute ? 0 : 1;
}

/** 0..1 meter reading for a source (0 when it has no node). */
export function readLevel(id) {
  const node = nodes.get(id);
  if (!node) return 0;
  return levelFrom(node.chain.analyser);
}

export function readMasterLevel() {
  if (!masterAnalyser) return 0;
  return levelFrom(masterAnalyser);
}

function levelFrom(analyser) {
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  const value = Math.sqrt(sum / buf.length);
  // perceptual-ish curve so silence ≈ 0 and 0 dBFS ≈ 1
  return Math.min(1, value * 4);
}

export function levelToDb(level) {
  if (level <= 0.001) return -60;
  return Math.max(-60, 20 * Math.log10(level));
}

export function audioRunning() {
  return !!ctx && ctx.state === 'running';
}

export function getStreamAudio() {
  if (!ensureContext()) return null;
  return streamDest.stream;
}

export function hasAudioContext() {
  return !!ctx;
}
