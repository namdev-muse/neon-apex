// Neon Apex v0.1.0 — Three.js presentation layer.
// The runner auto-sprints forward along floating neon platforms
// (sim forward = +s, world forward = -z). Jump / double-jump /
// slide / lane-switch with momentum; perfect landings chain speed;
// void falls and barrier hits reset to the last checkpoint. The
// pure sim lives in physics.js — this file only renders it, feeds
// it input, and plays the feedback.
//
// Anti-slop: no auto-jump, no assist, no "jump now" prompt, no
// landing preview. The menu runs a live attract demo (the decision
// bot playing track 1) behind the screen stack.
import * as THREE from 'three';
import {
  VERSION, TRACKS, trackById, startRun, stepRun, drainEvents,
  decisionPolicy, platformXAt, LANES, DT,
  recordBest, isTrackUnlocked, defaultSave, serializeSave, parseSave,
  FEEDBACK, FEEDBACK_LAYERS,
} from './physics.js';

const SAVE_KEY = 'neon-apex-save-v1';
const FOV_BASE = 62;

// ---------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------
let save = defaultSave();
try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) save = parseSave(raw);
} catch { /* private mode — play without saving */ }
function persistSave() {
  try { localStorage.setItem(SAVE_KEY, serializeSave(save)); } catch { /* ignore */ }
}
function applySettingsToDom() {
  document.documentElement.style.fontSize = `${(save.settings.textSize || 1) * 100}%`;
  document.body.classList.toggle('high-contrast', !!save.settings.highContrast);
  const vol = document.getElementById('volume-range');
  if (vol) { vol.value = Math.round((save.settings.volume ?? 0.6) * 100); }
  const volVal = document.getElementById('volume-value');
  if (volVal) volVal.textContent = `${Math.round((save.settings.volume ?? 0.6) * 100)}%`;
  const shake = document.getElementById('shake-range');
  if (shake) { shake.value = Math.round((save.settings.shake ?? 1) * 100); }
  const shakeVal = document.getElementById('shake-value');
  if (shakeVal) shakeVal.textContent = `${Math.round((save.settings.shake ?? 1) * 100)}%`;
  const shakeP = document.getElementById('shake-range-pause');
  if (shakeP) { shakeP.value = Math.round((save.settings.shake ?? 1) * 100); }
  const shakePV = document.getElementById('shake-value-pause');
  if (shakePV) shakePV.textContent = `${Math.round((save.settings.shake ?? 1) * 100)}%`;
  const music = document.getElementById('music-toggle');
  if (music) music.checked = save.settings.music !== false;
  const sfx = document.getElementById('sfx-toggle');
  if (sfx) sfx.checked = save.settings.sfx !== false;
  const rf = document.getElementById('reduce-flashing');
  if (rf) rf.checked = !!save.settings.reduceFlashing;
  const ts = document.getElementById('text-size-select');
  if (ts) ts.value = String(save.settings.textSize || 1);
  const hc = document.getElementById('high-contrast-toggle');
  if (hc) hc.checked = !!save.settings.highContrast;
  updateMuteLabels();
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  phase: 'menu', // menu | run | paused | complete
  trackId: 1,
  run: null,
  demoRun: null,
  autopilot: false,
  selectedTrack: 1,
  screenStack: ['menu'],
};
let selectedTrack = 1;
let trauma = 0;
let hitStopT = 0;
let slowMoT = 0;
let fovPulse = 0;
let squashT = 0;
let timeScale = 1;
let shakeAmp = 0;
let simAcc = 0;
let snapCamera = false;
let musicStep = 0;
let musicNextTime = 0;
const feedbackLog = [];
const input = { jump: false, slide: false, lane: null }; // lane: absolute target or null

// ---------------------------------------------------------------------
// Audio (Web Audio synth SFX + a small step sequencer)
// ---------------------------------------------------------------------
let audioCtx = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;
function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return true;
  }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = save.settings.muted ? 0 : (save.settings.volume ?? 0.6);
    masterGain.connect(audioCtx.destination);
    musicGain = audioCtx.createGain();
    musicGain.gain.value = 0.5;
    musicGain.connect(masterGain);
    sfxGain = audioCtx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(masterGain);
    return true;
  } catch { return false; }
}
function tone(freq, dur, type = 'sine', vol = 0.3, slideTo = null, when = 0) {
  if (!audioCtx || !sfxGain || save.settings.sfx === false) return;
  const t0 = audioCtx.currentTime + when;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(sfxGain);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function noiseBurst(dur, vol = 0.25, lowpass = 1200) {
  if (!audioCtx || !sfxGain || save.settings.sfx === false) return;
  const t0 = audioCtx.currentTime;
  const len = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const f = audioCtx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = lowpass;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(sfxGain);
  src.start(t0);
}
const SFX = {
  jump() { tone(280, 0.14, 'square', 0.16, 520); },
  doubleJump() { tone(420, 0.14, 'square', 0.16, 760); },
  slide() { noiseBurst(0.18, 0.18, 900); },
  land() { tone(140, 0.09, 'sine', 0.22, 70); noiseBurst(0.06, 0.1, 500); },
  perfect() { tone(660, 0.1, 'sine', 0.22); tone(990, 0.14, 'sine', 0.22, null, 0.07); },
  orb() { tone(880, 0.1, 'sine', 0.2, 1320); },
  checkpoint() { tone(523, 0.1, 'sine', 0.2); tone(659, 0.1, 'sine', 0.2, null, 0.08); tone(784, 0.16, 'sine', 0.22, null, 0.16); },
  death() { noiseBurst(0.35, 0.3, 700); tone(220, 0.4, 'sawtooth', 0.18, 55); },
  finish() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'sine', 0.22, null, i * 0.1)); },
  lane() { noiseBurst(0.08, 0.1, 2400); },
  click() { tone(1200, 0.04, 'square', 0.1); },
};
// Music: 8-step loop, A-minor bass + hats. Runs only while the audio
// context is live and music is on; the step counter is exposed for
// the render check.
const BASS = [55, 0, 55, 65.41, 55, 0, 82.41, 65.41];
function musicTick() {
  if (!audioCtx || !musicGain || save.settings.music === false || save.settings.muted) return;
  const now = audioCtx.currentTime;
  if (musicNextTime < now) musicNextTime = now + 0.05;
  while (musicNextTime < now + 0.25) {
    const step = musicStep % 8;
    const when = musicNextTime - now;
    if (BASS[step]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'triangle';
      o.frequency.value = BASS[step];
      g.gain.setValueAtTime(0.0001, now + when);
      g.gain.exponentialRampToValueAtTime(0.32, now + when + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + when + 0.2);
      o.connect(g); g.connect(musicGain);
      o.start(now + when); o.stop(now + when + 0.22);
    }
    if (step % 2 === 1) {
      const len = Math.floor(audioCtx.sampleRate * 0.03);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) * 0.5;
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const g = audioCtx.createGain();
      g.gain.value = 0.12;
      src.connect(g); g.connect(musicGain);
      src.start(now + when);
    }
    musicStep++;
    musicNextTime += 0.22;
  }
}

// ---------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------
let renderer = null;
const container = document.getElementById('game-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070818);
scene.fog = new THREE.FogExp2(0x070818, 0.010);
const camera = new THREE.PerspectiveCamera(FOV_BASE, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(0, 3.6, 7.5);

const hemi = new THREE.HemisphereLight(0x8b9dff, 0x1a0b2e, 1.15);
scene.add(hemi);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.3);
dirLight.position.set(6, 12, 4);
scene.add(dirLight);
scene.add(dirLight.target);

// Shared geometry / materials (one palette, reused everywhere).
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitBoxEdges = new THREE.EdgesGeometry(unitBox);
const orbGeo = new THREE.IcosahedronGeometry(0.45, 0);
const platformMat = new THREE.MeshStandardMaterial({ color: 0x4a3590, emissive: 0x241547, emissiveIntensity: 1.0, roughness: 0.55, metalness: 0.25 });
const wallMat = new THREE.MeshStandardMaterial({ color: 0x9d174d, emissive: 0xf472b6, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0.2 });
const overMat = new THREE.MeshStandardMaterial({ color: 0x9d174d, emissive: 0xec4899, emissiveIntensity: 0.8, roughness: 0.4, metalness: 0.2 });
const orbMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xfbbf24, emissiveIntensity: 1.4, roughness: 0.3, metalness: 0.4 });
const checkpointMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee });
const finishMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });

// Void city below + stars + grid (follow the runner).
const CITY_COUNT = 200;
const cityMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({ color: 0x141338, emissive: 0x1e1846, emissiveIntensity: 0.85, roughness: 0.9 }), CITY_COUNT);
cityMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
scene.add(cityMesh);
function layoutCity(track) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const span = track.length + 80;
  for (let i = 0; i < CITY_COUNT; i++) {
    const s = (i / CITY_COUNT) * span - 20 + ((i * 37) % 13) - 6;
    const side = i % 2 === 0 ? -1 : 1;
    const x = side * (14 + ((i * 53) % 46));
    const h = 8 + ((i * 29) % 26);
    const w = 4 + ((i * 17) % 7);
    pos.set(x, -42 + h / 2, -s);
    scl.set(w, h, w);
    m.compose(pos, q, scl);
    cityMesh.setMatrixAt(i, m);
  }
  cityMesh.instanceMatrix.needsUpdate = true;
}
const starGeo = new THREE.BufferGeometry();
{
  const N = 420;
  const p = new Float32Array(N * 3);
  const c = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;
    const e = Math.random() * Math.PI * 0.55 + 0.05;
    const r = 220 + Math.random() * 120;
    p[i * 3] = Math.cos(a) * Math.cos(e) * r;
    p[i * 3 + 1] = Math.sin(e) * r - 20;
    p[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
    const tint = Math.random();
    c[i * 3] = tint > 0.8 ? 1 : 0.6;
    c[i * 3 + 1] = tint > 0.8 ? 0.75 : 0.8;
    c[i * 3 + 2] = 1;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(c, 3));
}
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, vertexColors: true, sizeAttenuation: false, fog: false }));
scene.add(stars);
const grid = new THREE.GridHelper(320, 64, 0x22d3ee, 0x1e1b4b);
grid.position.y = -30;
grid.material.transparent = true;
grid.material.opacity = 0.25;
scene.add(grid);

// Runner mesh.
const runnerGroup = new THREE.Group();
const runnerBodyMat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0e7490, emissiveIntensity: 1.3, roughness: 0.35, metalness: 0.3 });
const runnerBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.72, 4, 12), runnerBodyMat);
runnerBody.position.y = 0.1;
runnerGroup.add(runnerBody);
const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.1), new THREE.MeshBasicMaterial({ color: 0xfbbf24 }));
visor.position.set(0, 0.32, -0.3);
runnerGroup.add(visor);
const finGeo = new THREE.BoxGeometry(0.08, 0.5, 0.42);
const finMat = new THREE.MeshStandardMaterial({ color: 0xf472b6, emissive: 0x9d174d, emissiveIntensity: 0.8, roughness: 0.4 });
const finL = new THREE.Mesh(finGeo, finMat);
finL.position.set(-0.38, -0.05, 0.1);
runnerGroup.add(finL);
const finR = new THREE.Mesh(finGeo, finMat);
finR.position.set(0.38, -0.05, 0.1);
runnerGroup.add(finR);
scene.add(runnerGroup);

// Particles (one InstancedMesh, pooled) + trail (same pool, cyan).
const PARTICLE_MAX = 72;
const particleMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ color: 0xffffff }), PARTICLE_MAX);
particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
particleMesh.count = PARTICLE_MAX;
scene.add(particleMesh);
const particles = [];
for (let i = 0; i < PARTICLE_MAX; i++) {
  particles.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0.2, color: new THREE.Color(0x22d3ee) });
  particleMesh.setColorAt(i, particles[i].color);
}
const dummy = new THREE.Object3D();
function spawnParticles(x, y, z, colorHex, count, speed, up = 2) {
  let spawned = 0;
  for (const p of particles) {
    if (spawned >= count) break;
    if (p.alive) continue;
    p.alive = true;
    p.x = x; p.y = y; p.z = z;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * speed;
    p.vx = Math.cos(a) * r;
    p.vz = Math.sin(a) * r;
    p.vy = (Math.random() - 0.3) * up;
    p.maxLife = 0.45 + Math.random() * 0.35;
    p.life = p.maxLife;
    p.size = 0.14 + Math.random() * 0.16;
    p.color.setHex(colorHex);
    particleMesh.setColorAt(particles.indexOf(p), p.color);
    spawned++;
  }
  if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;
}
function updateParticles(dt) {
  for (let i = 0; i < PARTICLE_MAX; i++) {
    const p = particles[i];
    if (p.alive) {
      p.life -= dt;
      if (p.life <= 0) { p.alive = false; dummy.scale.setScalar(0.0001); }
      else {
        p.vy -= 6 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        dummy.scale.setScalar(p.size * (p.life / p.maxLife));
      }
    } else {
      dummy.scale.setScalar(0.0001);
    }
    dummy.position.set(p.x, p.y, p.z);
    dummy.updateMatrix();
    particleMesh.setMatrixAt(i, dummy.matrix);
  }
  particleMesh.instanceMatrix.needsUpdate = true;
}
// Trail: a fading ribbon of dots behind the runner.
const TRAIL_MAX = 22;
const trailMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.55 }), TRAIL_MAX);
trailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(trailMesh);
const trail = [];
for (let i = 0; i < TRAIL_MAX; i++) trail.push({ alive: false, x: 0, y: 0, z: 0, life: 0 });
let trailTimer = 0;
function updateTrail(dt, run) {
  trailTimer -= dt;
  if (run && (run.grounded || run.y > 0) && trailTimer <= 0) {
    trailTimer = 0.028;
    const slot = trail.find((t) => !t.alive) || trail[0];
    slot.alive = true; slot.life = 0.4;
    slot.x = run.x; slot.y = run.y + 0.7; slot.z = -run.s + 0.6;
  }
  for (let i = 0; i < TRAIL_MAX; i++) {
    const t = trail[i];
    if (t.alive) {
      t.life -= dt;
      if (t.life <= 0) { t.alive = false; dummy.scale.setScalar(0.0001); }
      else dummy.scale.setScalar(0.16 * (t.life / 0.4));
    } else dummy.scale.setScalar(0.0001);
    dummy.position.set(t.x, t.y, t.z);
    dummy.updateMatrix();
    trailMesh.setMatrixAt(i, dummy.matrix);
  }
  trailMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------
// Track meshes
// ---------------------------------------------------------------------
let trackGroup = null;
let platformMeshes = []; // { mesh, edge, platform }
let orbMeshes = []; // { mesh, orb }
let barrierMeshes = [];
let currentTrack = null;
let currentEdgeMat = null;

function disposeTrackGroup() {
  if (!trackGroup) return;
  scene.remove(trackGroup);
  trackGroup.traverse((o) => {
    if (o.geometry && o.geometry !== unitBox && o.geometry !== unitBoxEdges && o.geometry !== orbGeo) o.geometry.dispose();
  });
  trackGroup = null;
  platformMeshes = [];
  orbMeshes = [];
  barrierMeshes = [];
}

function buildTrackMeshes(track) {
  disposeTrackGroup();
  currentTrack = track;
  trackGroup = new THREE.Group();
  if (currentEdgeMat) currentEdgeMat.dispose();
  currentEdgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(track.accent), transparent: true, opacity: 0.9 });
  for (const p of track.platforms) {
    const width = p.halfWidth * 2;
    const len = p.s1 - p.s0;
    const mesh = new THREE.Mesh(unitBox, platformMat);
    mesh.scale.set(width, 0.7, len);
    mesh.position.set(p.baseX, -0.36, -(p.s0 + p.s1) / 2);
    trackGroup.add(mesh);
    const edge = new THREE.LineSegments(unitBoxEdges, currentEdgeMat);
    edge.scale.set(width, 0.72, len);
    edge.position.set(p.baseX, -0.01, -(p.s0 + p.s1) / 2);
    trackGroup.add(edge);
    platformMeshes.push({ mesh, edge, platform: p });
  }
  for (const b of track.barriers) {
    const x = LANES[b.lane + 1];
    let mesh;
    if (b.kind === 'wall') {
      mesh = new THREE.Mesh(unitBox, wallMat);
      mesh.scale.set(2.3, 3.0, 0.8);
      mesh.position.set(x, 1.5, -b.s);
    } else {
      mesh = new THREE.Mesh(unitBox, overMat);
      mesh.scale.set(2.3, 2.0, 0.8);
      mesh.position.set(x, 2.0, -b.s);
    }
    trackGroup.add(mesh);
    barrierMeshes.push(mesh);
  }
  for (const o of track.orbs) {
    const mesh = new THREE.Mesh(orbGeo, orbMat);
    mesh.position.set(LANES[o.lane + 1], o.y + 0.6, -o.s);
    trackGroup.add(mesh);
    orbMeshes.push({ mesh, orb: o });
  }
  for (const cp of track.checkpoints) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.13, 8, 32), checkpointMat);
    ring.position.set(0, 1.7, -cp.s);
    trackGroup.add(ring);
  }
  const gate = new THREE.Mesh(new THREE.TorusGeometry(2.9, 0.2, 8, 40), finishMat);
  gate.position.set(0, 2.4, -track.finishS);
  trackGroup.add(gate);
  for (const px of [-3.4, 3.4]) {
    const pillar = new THREE.Mesh(unitBox, finishMat);
    pillar.scale.set(0.35, 4.8, 0.35);
    pillar.position.set(px, 2.4, -track.finishS);
    trackGroup.add(pillar);
  }
  scene.add(trackGroup);
  layoutCity(track);
}

// ---------------------------------------------------------------------
// Feedback (game-feel tiers: sound, particles, shake, flash, pop,
// hit-stop, slow-mo, FOV pulse, glow pulse — 5+ layers per event)
// ---------------------------------------------------------------------
const hitFlashEl = document.getElementById('hit-flash');
const popsEl = document.getElementById('pops');
function runnerScreenPos() {
  const v = new THREE.Vector3(runnerGroup.position.x, runnerGroup.position.y, runnerGroup.position.z);
  v.project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
}
function spawnPop(text, kind = '') {
  const pos = runnerScreenPos();
  const el = document.createElement('div');
  el.className = `pop ${kind}`;
  el.textContent = text;
  el.style.left = `${pos.x - 30}px`;
  el.style.top = `${pos.y - 40}px`;
  popsEl.appendChild(el);
  setTimeout(() => el.remove(), 950);
}
let toastTimer = null;
function showToast(text) {
  const el = document.getElementById('hud-toast');
  el.textContent = text;
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
  }, 1600);
}
function hideToast() {
  const el = document.getElementById('hud-toast');
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}
function flash() {
  if (save.settings.reduceFlashing) return;
  hitFlashEl.classList.add('show');
  setTimeout(() => hitFlashEl.classList.remove('show'), 120);
}
function feedback(type, extra = {}) {
  const fb = FEEDBACK[type];
  if (!fb) return;
  const layers = FEEDBACK_LAYERS[type] || [];
  feedbackLog.push({ type, layers: [...layers], t: Date.now() });
  if (feedbackLog.length > 160) feedbackLog.shift();
  trauma = Math.min(1, trauma + fb.trauma * (save.settings.shake ?? 1));
  if (fb.hitStop > 0) hitStopT = Math.max(hitStopT, fb.hitStop);
  if (layers.includes('fovPulse')) fovPulse = 1;
  const run = activeRun(); // the demo run in the menu, the live run in play
  const wx = run ? run.x : 0;
  const wy = run ? run.y + 0.8 : 0.8;
  const wz = run ? -run.s : 0;
  // The menu attract demo plays the same feedback, but quietly:
  // no toasts, pops or flashes over the menu — the scene behind
  // it already shows the game is alive.
  const quiet = state.phase === 'menu';
  if (layers.includes('particles')) {
    const color = { jump: 0x22d3ee, doubleJump: 0x67e8f9, slide: 0x9db8d6, land: 0x22d3ee, perfect: 0xf472b6, orb: 0xfbbf24, checkpoint: 0x22d3ee, death: 0xfb7185, finish: 0xfbbf24, lane: 0x22d3ee }[type] || 0x22d3ee;
    spawnParticles(wx, wy, wz, color, type === 'death' ? 26 : type === 'perfect' ? 18 : 10, type === 'death' ? 6 : 3.5);
  }
  if (layers.includes('flash') && !quiet) flash();
  if (layers.includes('slowMo')) { slowMoT = 0.7; }
  if (layers.includes('squash') && (type === 'land' || type === 'death')) squashT = 0.22;
  if (type === 'perfect' && !quiet) spawnPop(`PERFECT x${extra.chain || 1}  +${extra.points || 0}`, 'perfect');
  if (type === 'orb' && !quiet) spawnPop('+50');
  if (type === 'checkpoint' && !quiet) showToast('Checkpoint');
  if (type === 'death' && !quiet) showToast(extra.cause === 'void' ? 'Fell into the void — back to the checkpoint' : extra.cause === 'wall' ? 'Smashed into a wall — back to the checkpoint' : 'Clipped a barrier — back to the checkpoint');
  if (type === 'finish' && !quiet) showToast('Track clear!');
  if (SFX[type]) SFX[type]();
  if (layers.includes('glowPulse')) runnerBodyMat.emissiveIntensity = 2.4;
}

// ---------------------------------------------------------------------
// Screen stack
// ---------------------------------------------------------------------
const SCREENS = ['menu', 'howto', 'settings', 'complete', 'pause'];
function showOnly(id) {
  for (const s of SCREENS) {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  }
  if (id) {
    const primary = document.querySelector(`#${id} .btn.primary`);
    if (primary) primary.focus();
  }
}
function pushScreen(id) {
  state.screenStack.push(id);
  showOnly(id);
  hideToast();
}
function popScreen() {
  state.screenStack.pop();
  const top = state.screenStack[state.screenStack.length - 1];
  // An empty stack means "no overlay" (in-run): do NOT fall back
  // to the menu — resuming from pause must not show the menu.
  showOnly(top || null);
  hideToast();
  return top || null;
}
function resetStackTo(id) {
  state.screenStack = [id];
  showOnly(id);
  hideToast();
}

// ---------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------
function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
function buildMenu() {
  const sel = document.getElementById('track-select');
  sel.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const unlocked = isTrackUnlocked(save.best, t.id);
    const best = save.best[t.id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `track-card${t.id === selectedTrack ? ' selected' : ''}${unlocked ? '' : ' locked'}`;
    card.style.animationDelay = `${i * 0.05}s`;
    card.innerHTML = `<div class="track-name">Track ${t.id} — ${t.name}</div>`
      + `<div class="track-meta">Par ${fmtTime(t.par)} &middot; ${t.orbCount} orbs &middot; ${t.platforms.length} platforms</div>`
      + `<div class="track-best">${unlocked ? (best ? `Best ${fmtTime(best.time)} &middot; ${best.score.toLocaleString()} pts` : 'Not cleared yet') : `Clear Track ${t.id - 1} to unlock`}</div>`;
    card.addEventListener('click', () => {
      ensureAudio();
      if (!unlocked) { showToast(`Clear Track ${t.id - 1} first`); return; }
      selectedTrack = t.id;
      SFX.click();
      buildMenu();
      updateMenuHint();
    });
    card.addEventListener('mouseenter', () => { if (audioCtx) SFX.click(); });
    sel.appendChild(card);
  });
  const best1 = save.best[selectedTrack];
  const menuBest = document.getElementById('menu-best');
  const t = trackById(selectedTrack);
  menuBest.textContent = best1
    ? `Best on Track ${selectedTrack} (${t.name}): ${fmtTime(best1.time)} — ${best1.score.toLocaleString()} pts`
    : `Track ${selectedTrack} (${t.name}) — no best yet. Set the pace.`;
  updateMenuHint();
}
function updateMenuHint() {
  const t = trackById(selectedTrack);
  document.getElementById('track-hint').textContent = t ? t.hint : '';
}
function updateMuteLabels() {
  const label = save.settings.muted ? 'Sound: Off' : 'Sound: On';
  for (const id of ['btn-mute-menu', 'btn-mute-hud', 'btn-mute-pause']) {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  }
}
function toggleMute() {
  save.settings.muted = !save.settings.muted;
  if (masterGain) masterGain.gain.value = save.settings.muted ? 0 : (save.settings.volume ?? 0.6);
  persistSave();
  updateMuteLabels();
}

// ---------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------
function startTrack(id) {
  const track = trackById(id);
  if (!track) return;
  ensureAudio();
  state.trackId = id;
  selectedTrack = id;
  state.run = startRun(track);
  state.autopilot = false;
  state.phase = 'run';
  simAcc = 0;
  trauma = 0; hitStopT = 0; slowMoT = 0;
  buildTrackMeshes(track);
  runnerGroup.visible = true;
  snapCamera = true;
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('hud-track').textContent = `Track ${track.id} — ${track.name}`;
  const best = save.best[id];
  document.getElementById('hud-best').textContent = best ? `Best ${fmtTime(best.time)}` : 'Best —';
  resetStackTo(null);
  document.getElementById('menu').classList.add('hidden');
  for (const s of ['howto', 'settings', 'complete', 'pause']) document.getElementById(s).classList.add('hidden');
  state.screenStack = [];
  document.getElementById('sr-status').textContent = `Track ${track.id} ${track.name} started`;
}
function quitToMenu() {
  state.phase = 'menu';
  state.run = null;
  state.autopilot = false;
  document.getElementById('hud').classList.add('hidden');
  buildMenu();
  resetStackTo('menu');
  state.demoRun = startRun(TRACKS[0]);
  if (currentTrack !== TRACKS[0]) buildTrackMeshes(TRACKS[0]);
  snapCamera = true;
  document.getElementById('sr-status').textContent = 'Main menu';
}
function pauseGame() {
  if (state.phase !== 'run') return;
  state.phase = 'paused';
  pushScreen('pause');
}
function resumeGame() {
  if (state.phase !== 'paused') return;
  state.phase = 'run';
  popScreen();
}
function restartTrack() {
  if (!state.run) return;
  startTrack(state.trackId);
}
function finishRun() {
  const run = state.run;
  const track = run.track;
  const isBest = !save.best[track.id] || run.time < save.best[track.id].time;
  save.best = recordBest(save.best, track.id, { time: run.time, score: run.score, orbs: run.orbs, deaths: run.deaths });
  persistSave();
  state.phase = 'complete';
  state.autopilot = false;
  document.getElementById('complete-score').textContent = `Score ${run.score.toLocaleString()}`;
  document.getElementById('complete-detail').textContent =
    `Track ${track.id} — ${track.name} cleared in ${fmtTime(run.time)} (par ${fmtTime(track.par)}), ${run.deaths} death${run.deaths === 1 ? '' : 's'}, best chain x${run.maxChain}.`;
  document.getElementById('complete-best').textContent = isBest
    ? `New best time for this track!`
    : `Best for this track: ${fmtTime(save.best[track.id].time)}.`;
  document.getElementById('complete-orbs').textContent = `Orbs ${run.orbs}/${track.orbCount} · Perfect landings ${run.perfects}`;
  const next = trackById(track.id + 1);
  const btnNext = document.getElementById('btn-next');
  if (next && isTrackUnlocked(save.best, next.id)) {
    btnNext.disabled = false;
    btnNext.textContent = `Next Track — ${next.name}`;
  } else if (next) {
    btnNext.disabled = true;
    btnNext.textContent = `Next Track — ${next.name} (locked)`;
  } else {
    btnNext.disabled = false;
    btnNext.textContent = 'All Tracks Clear — Play Again';
  }
  pushScreen('complete');
  document.getElementById('sr-status').textContent = `Track ${track.id} cleared in ${fmtTime(run.time)}`;
}

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------
function doJump() { if (state.phase === 'run') { ensureAudio(); input.jump = true; } }
function doSlide() { if (state.phase === 'run') { ensureAudio(); input.slide = true; } }
function doLane(dir) {
  if (state.phase !== 'run' || !state.run) return;
  ensureAudio();
  const cur = state.run.laneTarget;
  input.lane = Math.max(-1, Math.min(1, cur + dir));
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.code;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
  if (k === 'KeyM') { toggleMute(); return; }
  if (k === 'KeyR' && (state.phase === 'run' || state.phase === 'paused')) { restartTrack(); return; }
  if (k === 'KeyP') {
    if (state.phase === 'run') pauseGame();
    else if (state.phase === 'paused') resumeGame();
    return;
  }
  if (k === 'Escape') {
    const top = state.screenStack[state.screenStack.length - 1];
    if (top === 'howto' || top === 'settings') popScreen();
    else if (top === 'pause') resumeGame();
    return;
  }
  if (k === 'Enter') {
    const top = state.screenStack[state.screenStack.length - 1];
    if (top === 'pause') { resumeGame(); return; }
    if (top === 'menu') { startTrack(selectedTrack); return; }
    if (top === 'complete') { document.getElementById('btn-next').click(); return; }
  }
  if (state.phase !== 'run') return;
  if (k === 'Space' || k === 'KeyW' || k === 'ArrowUp') doJump();
  else if (k === 'KeyS' || k === 'ArrowDown') doSlide();
  else if (k === 'KeyA' || k === 'ArrowLeft') doLane(-1);
  else if (k === 'KeyD' || k === 'ArrowRight') doLane(1);
});

// Touch: tap = jump, swipe down = slide, swipe left/right = lane.
let touchStart = null;
container.addEventListener('pointerdown', (e) => {
  touchStart = { x: e.clientX, y: e.clientY, t: Date.now() };
});
container.addEventListener('pointerup', (e) => {
  if (!touchStart) return;
  const dx = e.clientX - touchStart.x;
  const dy = e.clientY - touchStart.y;
  const dt = Date.now() - touchStart.t;
  touchStart = null;
  if (state.phase !== 'run') return;
  if (dt < 350 && Math.abs(dx) < 14 && Math.abs(dy) < 14) { doJump(); return; }
  if (Math.abs(dy) > Math.abs(dx) && dy > 40) { doSlide(); return; }
  if (Math.abs(dx) > 40) { doLane(dx > 0 ? 1 : -1); }
});

// Buttons.
document.getElementById('btn-play').addEventListener('click', () => { ensureAudio(); SFX.click(); startTrack(selectedTrack); });
document.getElementById('btn-howto').addEventListener('click', () => { ensureAudio(); SFX.click(); pushScreen('howto'); });
document.getElementById('btn-howto-close').addEventListener('click', () => { SFX.click(); popScreen(); });
document.getElementById('btn-settings').addEventListener('click', () => { ensureAudio(); SFX.click(); pushScreen('settings'); });
document.getElementById('btn-settings-close').addEventListener('click', () => { SFX.click(); popScreen(); });
document.getElementById('btn-mute-menu').addEventListener('click', () => { ensureAudio(); toggleMute(); });
document.getElementById('btn-mute-hud').addEventListener('click', () => { ensureAudio(); toggleMute(); });
document.getElementById('btn-mute-pause').addEventListener('click', () => { ensureAudio(); toggleMute(); });
document.getElementById('btn-pause').addEventListener('click', () => { SFX.click(); pauseGame(); });
document.getElementById('btn-resume').addEventListener('click', () => { SFX.click(); resumeGame(); });
document.getElementById('btn-restart').addEventListener('click', () => { SFX.click(); restartTrack(); });
document.getElementById('btn-quit').addEventListener('click', () => { SFX.click(); quitToMenu(); });
document.getElementById('btn-replay').addEventListener('click', () => { SFX.click(); startTrack(state.trackId); });
document.getElementById('btn-next').addEventListener('click', () => {
  SFX.click();
  const next = trackById(state.trackId + 1);
  if (next && isTrackUnlocked(save.best, next.id)) startTrack(next.id);
  else startTrack(state.trackId);
});
document.getElementById('btn-menu-complete').addEventListener('click', () => { SFX.click(); quitToMenu(); });
// Hover tick on every button.
for (const b of document.querySelectorAll('.btn, .icon-btn, .track-card')) {
  b.addEventListener('mouseenter', () => { if (audioCtx && !save.settings.muted) SFX.click(); });
}
// Settings controls.
document.getElementById('volume-range').addEventListener('input', (e) => {
  save.settings.volume = Number(e.target.value) / 100;
  document.getElementById('volume-value').textContent = `${e.target.value}%`;
  if (masterGain) masterGain.gain.value = save.settings.muted ? 0 : save.settings.volume;
  persistSave();
});
function bindShake(id, labelId) {
  document.getElementById(id).addEventListener('input', (e) => {
    save.settings.shake = Number(e.target.value) / 100;
    document.getElementById(labelId).textContent = `${e.target.value}%`;
    document.getElementById('shake-range').value = e.target.value;
    document.getElementById('shake-value').textContent = `${e.target.value}%`;
    document.getElementById('shake-range-pause').value = e.target.value;
    document.getElementById('shake-value-pause').textContent = `${e.target.value}%`;
    persistSave();
  });
}
bindShake('shake-range', 'shake-value');
bindShake('shake-range-pause', 'shake-value-pause');
document.getElementById('music-toggle').addEventListener('change', (e) => { save.settings.music = e.target.checked; persistSave(); });
document.getElementById('sfx-toggle').addEventListener('change', (e) => { save.settings.sfx = e.target.checked; persistSave(); });
document.getElementById('reduce-flashing').addEventListener('change', (e) => { save.settings.reduceFlashing = e.target.checked; persistSave(); });
document.getElementById('text-size-select').addEventListener('change', (e) => {
  save.settings.textSize = Number(e.target.value);
  document.documentElement.style.fontSize = `${save.settings.textSize * 100}%`;
  persistSave();
});
document.getElementById('high-contrast-toggle').addEventListener('change', (e) => {
  save.settings.highContrast = e.target.checked;
  document.body.classList.toggle('high-contrast', e.target.checked);
  persistSave();
});

// ---------------------------------------------------------------------
// Events from the sim -> presentation
// ---------------------------------------------------------------------
function handleEvents(run) {
  for (const ev of drainEvents(run)) {
    switch (ev.type) {
      case 'jump': feedback('jump'); break;
      case 'doubleJump': feedback('doubleJump'); break;
      case 'slide': feedback('slide'); break;
      case 'lane': feedback('lane'); break;
      case 'land': feedback('land'); break;
      case 'perfect': feedback('perfect', { chain: ev.chain, points: ev.points }); break;
      case 'orb': {
        feedback('orb');
        const om = orbMeshes.find((m) => m.orb === ev.orb || (Math.abs(m.orb.s - ev.s) < 1.5 && m.orb.lane === ev.lane));
        if (om) om.mesh.visible = false;
        break;
      }
      case 'checkpoint': feedback('checkpoint'); break;
      case 'death':
        feedback('death', { cause: ev.cause });
        snapCamera = true;
        break;
      case 'finish': feedback('finish'); break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------
const hudCache = {};
function setHud(id, value) {
  if (hudCache[id] !== value) {
    hudCache[id] = value;
    document.getElementById(id).textContent = value;
  }
}
function updateHUD(run) {
  const track = run.track;
  setHud('hud-time', fmtTime(run.time));
  setHud('hud-score', `Score ${run.score.toLocaleString()}`);
  const chainEl = document.getElementById('hud-chain');
  const chainText = `Chain x${run.chain}`;
  if (hudCache['hud-chain'] !== chainText) {
    hudCache['hud-chain'] = chainText;
    chainEl.textContent = chainText;
    chainEl.classList.toggle('hot', run.chain >= 3);
  }
  setHud('hud-orbs', `Orbs ${run.orbs}/${track.orbCount}`);
  setHud('hud-deaths', `Deaths ${run.deaths}`);
  document.getElementById('low-speed').classList.toggle('show', run.chain >= 4);
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
function activeRun() {
  if (state.phase === 'run' || state.phase === 'paused' || state.phase === 'complete') return state.run;
  return state.demoRun;
}
const clock = new THREE.Clock();
let camInit = false;

function stepActiveRun() {
  const run = state.run;
  if (!run || run.done) return;
  let stepInput;
  if (state.autopilot) {
    stepInput = decisionPolicy(run.track, run);
  } else {
    stepInput = { jump: input.jump, slide: input.slide, lane: input.lane };
    input.jump = false;
    input.slide = false;
    // input.lane persists until the run's laneTarget matches it.
    if (input.lane !== null && run.laneTarget === input.lane) input.lane = null;
  }
  stepRun(run, stepInput, DT);
  handleEvents(run);
  if (run.done && run.completed) finishRun();
}

function animate() {
  requestAnimationFrame(animate);
  const rawDt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now() / 1000;

  // Real-time decay: trauma settles during hit-stop, FOV pulse fades.
  if (trauma > 0) trauma = Math.max(0, trauma - rawDt * 1.3);
  if (fovPulse > 0) fovPulse = Math.max(0, fovPulse - rawDt * 2.2);
  if (squashT > 0) squashT -= rawDt;
  if (slowMoT > 0) slowMoT -= rawDt;
  timeScale = slowMoT > 0 ? 0.3 : 1;

  // Music sequencer advances whenever audio is live.
  if (audioCtx && state.phase !== 'paused') musicTick();

  // Simulation: fixed steps, frozen during hit-stop.
  if (hitStopT > 0) {
    hitStopT -= rawDt;
  } else if (state.phase === 'run' && state.run) {
    simAcc += rawDt * timeScale;
    let guard = 0;
    while (simAcc >= DT && guard < 8) {
      stepActiveRun();
      simAcc -= DT;
      guard++;
      if (!state.run || state.run.done) { simAcc = 0; break; }
    }
    if (guard >= 8) simAcc = 0;
    updateHUD(state.run);
  } else if (state.phase === 'menu' && state.demoRun) {
    simAcc += rawDt;
    let guard = 0;
    while (simAcc >= DT && guard < 8) {
      const demo = state.demoRun;
      stepRun(demo, decisionPolicy(demo.track, demo), DT);
      handleEvents(demo);
      simAcc -= DT;
      guard++;
      if (demo.done) {
        state.demoRun = startRun(TRACKS[0]);
        break;
      }
    }
    if (guard >= 8) simAcc = 0;
  }

  const run = activeRun();
  if (run) {
    // Runner mesh follows the sim (screen space = world space here:
    // the camera looks down -z, so world +x is screen right).
    runnerGroup.position.set(run.x, run.y + 0.95, -run.s);
    const targetScaleY = run.sliding > 0 ? 0.55 : (squashT > 0 ? 0.8 : (run.grounded ? 1 : 1.12));
    runnerGroup.scale.y += (targetScaleY - runnerGroup.scale.y) * Math.min(1, rawDt * 14);
    runnerGroup.rotation.x = run.grounded ? 0 : -0.18;
    runnerGroup.rotation.z = THREE.MathUtils.clamp((run.x - LANES[run.laneTarget + 1]) * -0.06, -0.25, 0.25);
    // Moving platforms + orbs + barriers pulse.
    const t = run.time;
    for (const pm of platformMeshes) {
      if (pm.platform.move) {
        const px = platformXAt(pm.platform, t);
        pm.mesh.position.x = px;
        pm.edge.position.x = px;
      }
    }
    for (const om of orbMeshes) {
      if (!om.mesh.visible) continue;
      om.mesh.rotation.y += rawDt * 2.4;
      om.mesh.position.y = om.orb.y + 0.6 + Math.sin(now * 2.2 + om.orb.s) * 0.12;
    }
    const pulse = 0.75 + Math.sin(now * 3) * 0.25;
    wallMat.emissiveIntensity = pulse;
    overMat.emissiveIntensity = pulse * 0.9;
    updateTrail(rawDt, run);
    // Camera chase with lookahead + trauma shake (visual only).
    // Closer and lower than a first pass: the runner must read
    // clearly mid-frame, not hide behind the platform it stands on.
    const camTarget = new THREE.Vector3(run.x * 0.45, 3.6 + run.y * 0.3, -run.s + 7.5);
    const lookTarget = new THREE.Vector3(run.x * 0.45, 1.4 + run.y * 0.4, -run.s - 14);
    if (snapCamera || !camInit) {
      camera.position.copy(camTarget);
      camInit = true;
      snapCamera = false;
    } else {
      camera.position.lerp(camTarget, 1 - Math.exp(-7 * rawDt));
    }
    shakeAmp = trauma * trauma * (save.settings.shake ?? 1);
    if (shakeAmp > 0.001) {
      camera.position.x += (Math.random() - 0.5) * 2 * shakeAmp * 0.9;
      camera.position.y += (Math.random() - 0.5) * 2 * shakeAmp * 0.9;
    }
    camera.lookAt(lookTarget);
    const speedKick = THREE.MathUtils.clamp((run.speed - 10) * 1.1, 0, 8);
    const targetFov = FOV_BASE + speedKick + fovPulse * 3;
    if (Math.abs(camera.fov - targetFov) > 0.02) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, rawDt * 8);
      camera.updateProjectionMatrix();
    }
    dirLight.position.set(run.x + 6, 12, -run.s + 6);
    dirLight.target.position.set(run.x, 0, -run.s);
    dirLight.target.updateMatrixWorld();
    grid.position.z = -run.s;
    stars.position.z = -run.s;
    // Glow pulse settles back to its rest value.
    runnerBodyMat.emissiveIntensity += (1.3 - runnerBodyMat.emissiveIntensity) * Math.min(1, rawDt * 6);
  }
  updateParticles(rawDt);
  if (renderer) renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  if (renderer) renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
function boot() {
  applySettingsToDom();
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    document.getElementById('webgl-error').classList.remove('hidden');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (state.phase === 'run') pauseGame();
    showToast('Graphics paused — restoring…');
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    showToast('Graphics restored');
  });
  buildMenu();
  state.demoRun = startRun(TRACKS[0]);
  buildTrackMeshes(TRACKS[0]);
  resetStackTo('menu');
  animate();
}
boot();

// ---------------------------------------------------------------------
// Test hooks (window.__apex) — the bot harness, render check and
// screenshots drive the game through these public hooks only.
// ---------------------------------------------------------------------
function projectToScreen(x, y, z) {
  const v = new THREE.Vector3(x, y, z);
  v.project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
}
window.__apex = {
  version: VERSION,
  state,
  save() { return JSON.parse(JSON.stringify(save)); },
  tracks() {
    return TRACKS.map((t) => ({
      id: t.id, name: t.name, hint: t.hint, par: t.par,
      length: t.length, orbCount: t.orbCount,
      platforms: t.platforms.length, barriers: t.barriers.length,
      best: save.best[t.id] || null,
      unlocked: isTrackUnlocked(save.best, t.id),
    }));
  },
  unlocks() {
    const u = {};
    for (const t of TRACKS) u[t.id] = isTrackUnlocked(save.best, t.id);
    return u;
  },
  startTrack(id) { startTrack(id); },
  quitToMenu() { quitToMenu(); },
  restart() { restartTrack(); },
  pause() { pauseGame(); },
  resume() { resumeGame(); },
  jump() { doJump(); },
  slide() { doSlide(); },
  lane(dir) { doLane(dir); },
  setLane(i) { if (state.phase === 'run' && state.run) input.lane = Math.max(-1, Math.min(1, i)); },
  autopilot(on) { state.autopilot = !!on; },
  setShake(v) { save.settings.shake = v; persistSave(); },
  setReduceFlashing(v) { save.settings.reduceFlashing = v; persistSave(); },
  setTextSize(v) {
    save.settings.textSize = v;
    document.documentElement.style.fontSize = `${v * 100}%`;
    persistSave();
  },
  setHighContrast(v) {
    save.settings.highContrast = v;
    document.body.classList.toggle('high-contrast', v);
    persistSave();
  },
  setMuted(v) {
    save.settings.muted = v;
    if (masterGain) masterGain.gain.value = v ? 0 : (save.settings.volume ?? 0.6);
    persistSave(); updateMuteLabels();
  },
  info() {
    const run = activeRun();
    if (!run) return null;
    const scr = projectToScreen(run.x, run.y + 0.95, -run.s);
    return {
      phase: state.phase,
      trackId: state.trackId,
      s: run.s, x: run.x, y: run.y, vy: run.vy,
      speed: run.speed, grounded: run.grounded, sliding: run.sliding,
      lane: run.lane, laneTarget: run.laneTarget,
      chain: run.chain, maxChain: run.maxChain, perfects: run.perfects,
      score: run.score, orbs: run.orbs, deaths: run.deaths,
      time: run.time, completed: run.completed, done: run.done,
      checkpoints: run.checkpointIndex + 1,
      screen: scr,
      fov: camera.fov, trauma, timeScale, shakeAmp,
      feedback: feedbackLog.slice(),
      audio: audioCtx ? { state: audioCtx.state, music: save.settings.music !== false, musicStep } : null,
    };
  },
};
