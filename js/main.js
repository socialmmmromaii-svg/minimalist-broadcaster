/**
 * main.js — bootstrap: wire store, renderer, mixer, output and UI together.
 */

import {
  getState, update, subscribe, scheduleSave,
} from './store.js';
import {
  initRenderer, startRenderLoop, startTransition, onMediaResolved,
  getProgramCanvas, mediaDiagnostics, resumeMediaPlayback,
} from './renderer.js';

// NOTE: getProgramCanvas is a live binding to the program canvas element
// (not a factory function); it is used as `canvas: getProgramCanvas` below.
import { syncAudio, setMaster, audioRunning, hasAudioContext } from './audio.js';
import {
  isRecording, startRecording, stopRecording, recordingSupported, recordingElapsedMs,
  isStreaming, startStreaming, stopStreaming, streamingState,
} from './output.js';
import {
  wireControls, renderUI, renderProps, showToast,
  setRecordingUI, setStreamingUI, setRecordingTime, setFpsStatus, selectTab,
} from './ui.js';

/* -------------------------------------------------------------- actions -- */

function take(instant) {
  const state = getState();
  const from = state.programSceneId;
  const to = state.previewSceneId;
  if (from === to) return;

  const { type, duration } = state.transition;
  update((s) => { s.programSceneId = to; });
  if (!instant) startTransition(type, duration, from, to);
}

function swap() {
  update((s) => {
    const tmp = s.previewSceneId;
    s.previewSceneId = s.programSceneId;
    s.programSceneId = tmp;
    s.selectedSourceId = null;
  });
}

async function toggleRecord() {
  if (isRecording()) {
    const result = await stopRecording();
    setRecordingUI(false);
    setRecordingTime(0);
    if (result && result.blob && result.blob.size > 0) {
      const mb = (result.blob.size / (1024 * 1024)).toFixed(1);
      showToast(`Recording saved — ${result.filename} (${mb} MB)`, 'ok');
    } else {
      showToast('Recording stopped — no data was captured', 'error');
    }
    return;
  }
  if (!recordingSupported()) {
    showToast('Recording is not supported in this browser', 'error');
    return;
  }
  try {
    startRecording({ canvas: getProgramCanvas, fps: getState().fps });
    setRecordingUI(true);
    showToast('Recording the program output', 'ok');
  } catch (err) {
    showToast(err.message || 'Could not start recording', 'error');
  }
}

async function toggleStream() {
  if (isStreaming()) {
    await stopStreaming();
    setStreamingUI(false);
    showToast('Stream stopped', 'ok');
    return;
  }
  const { whipUrl, whipToken } = getState().stream;
  if (!whipUrl) {
    selectTab('panel-stream');
    showToast('Add a WHIP endpoint in the Stream panel first', 'error');
    const input = document.getElementById('whipUrl');
    if (input) input.focus();
    return;
  }
  try {
    await startStreaming({
      canvas: getProgramCanvas,
      fps: getState().fps,
      url: whipUrl,
      token: whipToken,
    });
    setStreamingUI(true);
    showToast('Streaming program output', 'ok');
  } catch (err) {
    setStreamingUI(false);
    showToast(err.message || 'Could not start the stream', 'error');
  }
}

/* ----------------------------------------------------------------- boot -- */

function boot() {
  const previewCanvas = document.getElementById('previewCanvas');
  const programCanvas = document.getElementById('programCanvas');
  if (!previewCanvas || !programCanvas) throw new Error('Studio canvases not found');

  initRenderer(previewCanvas, programCanvas);
  wireControls({ take, swap, toggleRecord, toggleStream });

  subscribe((state) => {
    syncAudio(state);
    setMaster(state.mixer.master.gain, state.mixer.master.mute);
    renderUI(state);
  });

  // camera/screen/file media resolves asynchronously — attach mixer nodes as
  // soon as the stream (or element) exists, not only on the next store change
  onMediaResolved(() => syncAudio(getState()));
  syncAudio(getState());
  setMaster(getState().mixer.master.gain, getState().mixer.master.mute);
  renderUI(getState());

  startRenderLoop((fps) => setFpsStatus(fps));

  // recording timer
  setInterval(() => {
    if (isRecording()) setRecordingTime(recordingElapsedMs());
  }, 500);

  // autoplay policy: audible media can only start after a gesture, and media
  // that finishes loading after that gesture needs a retry
  setInterval(resumeMediaPlayback, 1500);

  // if the peer connection dies under us, reflect it in the header
  setInterval(() => {
    if (isStreaming() && streamingState() === 'failed') {
      stopStreaming();
      setStreamingUI(false);
      showToast('The stream connection failed — check the endpoint', 'error');
    }
  }, 4000);

  window.__mb = {
    renderProps,
    getState,
    scheduleSave,
    take,
    swap,
    toggleRecord,
    toggleStream,
    showToast,
    mediaInfo: mediaDiagnostics,
    audioState: () => ({ running: audioRunning(), hasContext: hasAudioContext() }),
    version: '1.0.0',
    ready: true,
  };

  console.info('Minimalist Broadcaster ready');
}

try {
  boot();
} catch (err) {
  console.error('boot failed', err);
  const host = document.getElementById('toasts');
  if (host) {
    const el = document.createElement('div');
    el.className = 'toast toast--error';
    el.textContent = `Studio failed to start: ${err.message}`;
    host.appendChild(el);
  }
}
