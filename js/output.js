/**
 * output.js — everything that leaves the browser:
 *   • local recording of the program output (MediaRecorder → WebM download)
 *   • streaming over WebRTC/WHIP to an endpoint you control
 *
 * RTMP itself cannot be produced in a browser tab, so the Stream panel takes a
 * WHIP URL (an open-source relay like MediaMTX / OvenMediaEngine / SRS in
 * front of YouTube/Twitch/Facebook).
 */

import { getStreamAudio } from './audio.js';

/* -------------------------------------------------------------- recording -- */

let recorder = null;
let chunks = [];
let startedAt = 0;

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export function recordingSupported() {
  return typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

export function isRecording() {
  return !!recorder && recorder.state === 'recording';
}

export function recordingElapsedMs() {
  return isRecording() ? Date.now() - startedAt : 0;
}

export function startRecording({ canvas, fps }) {
  if (isRecording()) return true;
  if (!recordingSupported()) {
    throw new Error('Recording is not supported in this browser');
  }

  const stream = canvas.captureStream(fps);
  const audio = getStreamAudio();
  if (audio) {
    for (const track of audio.getAudioTracks()) stream.addTrack(track);
  }

  const mime = pickMime();
  const options = mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : { videoBitsPerSecond: 6_000_000 };
  recorder = new MediaRecorder(stream, options);
  chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => {
    console.error('recorder error', e);
  };

  recorder.start(1000);
  startedAt = Date.now();
  return true;
}

/** Stop and download the file. Returns { blob, filename } or null. */
export function stopRecording() {
  if (!recorder) return null;
  const rec = recorder;
  const type = rec.mimeType || 'video/webm';

  return new Promise((resolve) => {
    rec.onstop = () => {
      const blob = new Blob(chunks, { type });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const filename = `minimalist-broadcaster-${stamp}.${ext}`;
      download(blob, filename);
      recorder = null;
      chunks = [];
      resolve({ blob, filename });
    };
    try { rec.stop(); } catch (err) { console.error('stop failed', err); recorder = null; resolve(null); }
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* --------------------------------------------------------------- streaming -- */

let pc = null;
let whipSessionUrl = null;

export function isStreaming() {
  return !!pc;
}

function buildOutputStream(canvas, fps) {
  const stream = canvas.captureStream(fps);
  const audio = getStreamAudio();
  if (audio) for (const track of audio.getAudioTracks()) stream.addTrack(track);
  return stream;
}

async function waitIceComplete(peer, timeoutMs = 8000) {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    peer.addEventListener('icegatheringstatechange', () => {
      if (peer.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/**
 * Start a WHIP session.
 * @returns {Promise<void>} rejects with a descriptive Error on failure
 */
export async function startStreaming({ canvas, fps, url, token }) {
  if (pc) return;
  if (!/^https:\/\//i.test(url || '')) {
    throw new Error('Enter a valid HTTPS WHIP endpoint in the Stream panel');
  }

  const stream = buildOutputStream(canvas, fps);
  const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc = peer;

  for (const track of stream.getTracks()) {
    const sender = peer.addTransceiver(track, { direction: 'sendonly' });
    void sender;
  }

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitIceComplete(peer);

  const headers = { 'Content-Type': 'application/sdp' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: peer.localDescription.sdp,
    });
  } catch (err) {
    teardownPeer();
    throw new Error(`Could not reach the endpoint: ${err.message}`);
  }

  if (!response.ok) {
    teardownPeer();
    const text = await response.text().catch(() => '');
    throw new Error(`Endpoint refused the stream (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const answer = await response.text();
  if (!answer || !answer.includes('v=0')) {
    teardownPeer();
    throw new Error('Endpoint returned an invalid SDP answer');
  }

  try {
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (err) {
    teardownPeer();
    throw new Error(`Invalid SDP answer: ${err.message}`);
  }

  const location = response.headers.get('Location');
  if (location) {
    try {
      whipSessionUrl = new URL(location, url).toString();
    } catch { whipSessionUrl = null; }
  }

  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed') {
      console.warn('WebRTC connection failed');
    }
  });
}

function teardownPeer() {
  if (pc) {
    try { pc.close(); } catch { /* ignore */ }
    pc = null;
  }
}

export async function stopStreaming() {
  if (whipSessionUrl) {
    try {
      await fetch(whipSessionUrl, { method: 'DELETE' });
    } catch { /* best effort */ }
  }
  whipSessionUrl = null;
  teardownPeer();
}

export function streamingState() {
  if (!pc) return 'idle';
  return pc.connectionState || 'connecting';
}
