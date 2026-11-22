// Neon Apex v0.1.0 — pure simulation core (no DOM, no Three.js).
// A 3D neon sky-parkour runner: the runner auto-sprints forward along
// a track of floating neon platforms (forward = +s; game.js maps s to
// world -z). The player jumps (Space / W / Up, double-jump in air),
// slides under overhead barriers (S / Down), and switches lanes (A/D
// or Left/Right). Landing dead-centre on a platform chains a speed
// multiplier; falling into the void or hitting a barrier resets the
// runner to the last checkpoint. Score comes from orbs, time, and
// perfect-landing chains; best time is saved per track. Deterministic:
// every track is hand-built from a fixed segment list, and the
// fixed-step simulation gives identical results for identical inputs.
//
// Anti-slop: no auto-jump, no assist, no "jump now" prompt, no
// landing preview — jump timing is the skill. The bot plays through
// the same stepRun + public input hooks and must jump/slide/switch
// lanes with real timing decisions; a bot that jumps at random dies
// on every track (see simulateRun + the bot harness).

export const VERSION = '0.1.0';
export const LANES = [-2.4, 0, 2.4];
export const LANE_COUNT = 3;
export const DT = 1 / 60;
export const GRAVITY = 30;
export const JUMP_VEL = 11.5;
export const DOUBLE_JUMP_VEL = 10.5;
export const LANE_SPEED = 9.5; // lateral units / second while switching lanes
export const SLIDE_TIME = 0.55; // seconds the slide lasts
export const RUNNER_HALF = 0.4; // support tolerance at platform edges
export const RUNNER_HEIGHT = 1.8;
export const SLIDE_HEIGHT = 0.8;
export const COYOTE_TIME = 0.12;
export const JUMP_BUFFER = 0.12;
export const VOID_Y = -8;
export const WALL_HEIGHT = 3.0; // full walls cannot be jumped (apex 2.2)
export const OVER_BOTTOM = 1.0; // overhead barrier hangs from y=1.0 to y=3.0: slide under it, never jump it
export const OVER_TOP = 3.0;
export const ORB_SCORE = 50;
export const PERFECT_BASE = 50;
export const PERFECT_STEP = 50; // +50 per chain link on a perfect landing
export const CHECKPOINT_SCORE = 25;
export const DEATH_TIME_PENALTY = 2; // seconds added to the clock per death
export const SAVE_VERSION = 1;

// --- feedback tiers (game-feel skill: small 0.10-0.20 / no stop,
// medium 0.30-0.50 / 0.04-0.06s, large 0.70-1.00 / 0.10-0.15s) ---
export const FEEDBACK_TIERS = {
  small: { traumaMin: 0.10, traumaMax: 0.20, stopMin: 0, stopMax: 0 },
  medium: { traumaMin: 0.30, traumaMax: 0.50, stopMin: 0.04, stopMax: 0.06 },
  large: { traumaMin: 0.70, traumaMax: 1.00, stopMin: 0.10, stopMax: 0.15 },
};
export const FEEDBACK = {
  jump: { tier: 'small', trauma: 0.12, hitStop: 0 },
  doubleJump: { tier: 'small', trauma: 0.12, hitStop: 0 },
  slide: { tier: 'small', trauma: 0.10, hitStop: 0 },
  land: { tier: 'small', trauma: 0.15, hitStop: 0 },
  perfect: { tier: 'small', trauma: 0.18, hitStop: 0 },
  orb: { tier: 'small', trauma: 0.12, hitStop: 0 },
  checkpoint: { tier: 'medium', trauma: 0.35, hitStop: 0.04 },
  death: { tier: 'large', trauma: 0.90, hitStop: 0.12 },
  finish: { tier: 'medium', trauma: 0.40, hitStop: 0.05 },
  lane: { tier: 'small', trauma: 0.10, hitStop: 0 },
};

// --- feedback layers (game-feel skill: one satisfying event is 5-8
// tiny responses firing together within ~100ms: sound, particles,
// shake, flash, knockback, hit-stop, slow-mo, FOV pulse, number pop.
// This is the contract game.js implements per event; the smoke test
// asserts every event carries at least 5 layers, and the render check
// asserts the layers actually fire in the browser (via the feedback
// log on window.__apex). ---
export const FEEDBACK_LAYERS = {
  jump: ['sound', 'particles', 'shake', 'fovPulse', 'glowPulse'],
  doubleJump: ['sound', 'particles', 'shake', 'fovPulse', 'glowPulse'],
  slide: ['sound', 'particles', 'shake', 'fovPulse', 'squash'],
  land: ['sound', 'particles', 'shake', 'squash', 'glowPulse'],
  perfect: ['sound', 'particles', 'shake', 'pop', 'glowPulse', 'fovPulse'],
  orb: ['sound', 'particles', 'shake', 'pop', 'glowPulse'],
  checkpoint: ['sound', 'particles', 'shake', 'hitStop', 'pop', 'toast', 'glowPulse'],
  death: ['sound', 'particles', 'shake', 'hitStop', 'flash', 'slowMo', 'squash', 'toast'],
  finish: ['sound', 'particles', 'shake', 'hitStop', 'pop', 'toast', 'fovPulse'],
  lane: ['sound', 'particles', 'shake', 'glowPulse', 'fovPulse'],
};

// --- seeded RNG (mulberry32) ---
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---------------------------------------------------------------------
// Track construction
// ---------------------------------------------------------------------
// A track is built from a segment list. Segment forms:
//   { p: len, lanes: [-1,0,1], ... }  platform of length `len` covering
//       the listed lanes. Optional extras on the platform:
//       move: { amp, period, phase } — the platform slides laterally
//           (x centre oscillates ±amp around its base centre)
//       wall: [{ at, lane }] — full-height wall barriers on the platform
//       over: [{ at, lane }] — overhead barriers (slide under) on it
//       orbs: [{ at, lane, y }] — energy orbs (y 0 = ground line,
//           y 1.8 = jump orb, only collectable mid-jump)
//       cp: true — a checkpoint at the start of this platform (+2s)
//   { g: len }  a gap of `len` with no platform (jump it).
// The builder lays the segments out from s=0 and appends a finish
// gate on the final platform. Track 1 always starts with a 16-unit
// all-lane platform so the first seconds are survivable.

function platformFromLanes(s0, len, lanes, move) {
  const xs = lanes.map((l) => LANES[l + 1]);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return {
    s0, s1: s0 + len, len,
    lanes: [...lanes],
    baseX: (lo + hi) / 2,
    halfWidth: (hi - lo) / 2 + 1.5,
    move: move ? { amp: move.amp, period: move.period, phase: move.phase || 0 } : null,
  };
}

// Lateral centre of a platform at run time t (moving platforms slide).
export function platformXAt(platform, t) {
  if (!platform.move) return platform.baseX;
  return platform.baseX + platform.move.amp * Math.sin((2 * Math.PI * t) / platform.move.period + platform.move.phase);
}

export function buildTrack(def) {
  let s = 0;
  const platforms = [];
  const barriers = [];
  const orbs = [];
  const checkpoints = [];
  for (const seg of def.segments) {
    if (seg.g) { s += seg.g; continue; }
    const plat = platformFromLanes(s, seg.p, seg.lanes, seg.move);
    platforms.push(plat);
    for (const w of seg.wall || []) barriers.push({ kind: 'wall', s: s + w.at, lane: w.lane });
    for (const o of seg.over || []) barriers.push({ kind: 'over', s: s + o.at, lane: o.lane });
    for (const o of seg.orbs || []) orbs.push({ s: s + o.at, lane: o.lane, y: o.y || 0, taken: false });
    if (seg.cp) checkpoints.push({ s: s + 2 });
    s += seg.p;
  }
  const finishS = s - 2;
  const length = s;
  return {
    id: def.id, name: def.name, seed: def.seed,
    hint: def.hint, baseSpeed: def.baseSpeed,
    accent: def.accent, sky: def.sky,
    platforms, barriers, orbs, checkpoints, finishS, length,
    par: Math.round(length / (def.baseSpeed * 1.08)),
    orbCount: orbs.length,
  };
}

// --- the six M1 tracks ---
// Identities: T1 teaches (wide platforms, small gaps, one wall, one
// over); T2 varies the gap rhythm and adds wall pairs; T3 is
// wall-heavy — lane switching is the test; T4 introduces moving
// platforms and the first double-jump gap; T5 mixes everything at
// higher speed; T6 is the tightest, fastest, everything-at-once run.
// Gaps: single-jump range at speed v is ~0.77s of flight, so a gap
// of g needs v >= g/0.70 to clear with one jump; gaps over that need
// the double jump (range ~1.45s of flight). Every gap below is
// inside the double-jump envelope for its track speed, and every
// gap over the single-jump envelope sits on T4+ where the double
// jump has already been taught by a wide, safe double-jump gap.
const TRACK_DEFS = [
  {
    id: 1, name: 'First Steps', seed: 101, baseSpeed: 10,
    hint: 'Run, jump the gaps, slide under the pink bars. Land dead-centre to chain speed.',
    accent: '#22d3ee', sky: '#0b1030',
    segments: [
      { p: 16, lanes: [-1, 0, 1] },
      { g: 2.5 },
      { p: 12, lanes: [-1, 0, 1], orbs: [{ at: 4, lane: 0 }, { at: 7, lane: 0 }, { at: 10, lane: 0 }] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1] },
      { g: 3 },
      { p: 14, lanes: [-1, 0, 1], cp: true },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 0 }] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1], orbs: [{ at: 4, lane: -1 }, { at: 7, lane: -1 }, { at: 10, lane: -1 }] },
      { g: 4 },
      { p: 14, lanes: [-1, 0, 1] },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: 1 }] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1], cp: true },
      { g: 4 },
      { p: 16, lanes: [-1, 0, 1], orbs: [{ at: 5, lane: 1, y: 1.8 }, { at: 8, lane: 1, y: 1.8 }, { at: 11, lane: 1, y: 1.8 }] },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: 0 }] },
      { g: 3.5 },
      { p: 14, lanes: [-1, 0, 1] },
    ],
  },
  {
    id: 2, name: 'Neon Steps', seed: 202, baseSpeed: 11,
    hint: 'The gaps change rhythm — short, long, short. Time every jump; the walls want you in the wrong lane.',
    accent: '#67e8f9', sky: '#0a0f2e',
    segments: [
      { p: 16, lanes: [-1, 0, 1] },
      { g: 3 },
      { p: 10, lanes: [-1, 0, 1], orbs: [{ at: 3, lane: 1 }, { at: 6, lane: 1 }] },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 1 }] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: 0 }] },
      { g: 5 },
      { p: 14, lanes: [-1, 0, 1], cp: true, orbs: [{ at: 5, lane: 0, y: 1.8 }, { at: 8, lane: 0, y: 1.8 }] },
      { g: 3.5 },
      { p: 10, lanes: [-1, 0, 1], wall: [{ at: 5, lane: -1 }] },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 0 }], over: [{ at: 9, lane: 1 }] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1], orbs: [{ at: 4, lane: 0 }, { at: 7, lane: 0 }, { at: 10, lane: 0 }] },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], cp: true },
      { g: 5 },
      { p: 14, lanes: [-1, 0, 1], over: [{ at: 7, lane: -1 }] },
      { g: 3.5 },
      { p: 16, lanes: [-1, 0, 1], orbs: [{ at: 5, lane: 1, y: 1.8 }, { at: 8, lane: -1, y: 1.8 }, { at: 11, lane: 0, y: 1.8 }] },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 1 }] },
      { g: 4 },
      { p: 14, lanes: [-1, 0, 1] },
    ],
  },
  {
    id: 3, name: 'Magenta Maze', seed: 303, baseSpeed: 11.5,
    hint: 'Walls everywhere — the open lane keeps moving. Read the pink, switch early, never jump into a wall.',
    accent: '#f472b6', sky: '#160a24',
    segments: [
      { p: 16, lanes: [-1, 0, 1] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 0 }] },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: -1 }] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 4, lane: 1 }, { at: 8, lane: 0 }] },
      { g: 4 },
      { p: 14, lanes: [-1, 0, 1], cp: true, orbs: [{ at: 5, lane: 1 }, { at: 8, lane: 1 }] },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 1 }], over: [{ at: 9, lane: 0 }] },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: -1 }], over: [{ at: 9, lane: 1 }] },
      { g: 3 },
      { p: 10, lanes: [-1, 0, 1], wall: [{ at: 5, lane: 0 }] },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], cp: true, orbs: [{ at: 4, lane: -1, y: 1.8 }, { at: 7, lane: 0, y: 1.8 }, { at: 10, lane: 1, y: 1.8 }] },
      { g: 5 },
      { p: 14, lanes: [-1, 0, 1], wall: [{ at: 7, lane: 0 }] },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: -1 }], wall: [{ at: 9, lane: 1 }] },
      { g: 4 },
      { p: 14, lanes: [-1, 0, 1], orbs: [{ at: 5, lane: 1 }, { at: 8, lane: 1 }, { at: 11, lane: 1 }] },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 0 }] },
      { g: 4 },
      { p: 14, lanes: [-1, 0, 1] },
    ],
  },
  {
    id: 4, name: 'Skyline Sprint', seed: 404, baseSpeed: 12,
    hint: 'The platforms drift now — land where the platform will be, not where it is. The long gap needs a double jump.',
    accent: '#a78bfa', sky: '#0d0a2a',
    segments: [
      { p: 16, lanes: [-1, 0, 1] },
      { g: 3 },
      { p: 12, lanes: [-1, 0, 1] },
      { g: 4 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.4 } },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 0 }] },
      { g: 7.5 },
      { p: 14, lanes: [-1, 0, 1], cp: true, orbs: [{ at: 5, lane: 0, y: 1.8 }, { at: 8, lane: 0, y: 1.8 }] },
      { g: 4 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.2, phase: 1.0 } },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: 1 }] },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: -1 }] },
      { g: 3 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.6, phase: 2.0 } },
      { g: 4 },
      { p: 14, lanes: [-1, 0, 1], cp: true, orbs: [{ at: 4, lane: 1 }, { at: 7, lane: 1 }, { at: 10, lane: 1 }] },
      { g: 7 },
      { p: 14, lanes: [-1, 0, 1] },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], orbs: [{ at: 4, lane: -1 }, { at: 7, lane: -1 }, { at: 10, lane: -1 }] },
      { g: 4 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.3, phase: 0.4 } },
      { g: 3.5 },
      { p: 14, lanes: [-1, 0, 1] },
    ],
  },
  {
    id: 5, name: 'Void Waltz', seed: 505, baseSpeed: 12.5,
    hint: 'Drifting platforms, walls and low bars in one rhythm. Double-jump the long gaps, slide the bars, switch for the walls.',
    accent: '#fbbf24', sky: '#120a20',
    segments: [
      { p: 16, lanes: [-1, 0, 1] },
      { g: 3.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 1 }] },
      { g: 4 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.2 } },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: 0 }], wall: [{ at: 9, lane: -1 }] },
      { g: 7.5 },
      { p: 14, lanes: [-1, 0, 1], cp: true, orbs: [{ at: 5, lane: 0, y: 1.8 }, { at: 8, lane: 0, y: 1.8 }] },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 4, lane: 0 }, { at: 8, lane: 1 }] },
      { g: 5 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.4, phase: 0.7 } },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: -1 }] },
      { g: 7 },
      { p: 14, lanes: [-1, 0, 1], cp: true },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 0 }], over: [{ at: 9, lane: 1 }] },
      { g: 5 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.0, phase: 1.5 } },
      { g: 4 },
      { p: 14, lanes: [-1, 0, 1], orbs: [{ at: 5, lane: -1, y: 1.8 }, { at: 8, lane: 1, y: 1.8 }, { at: 11, lane: 0, y: 1.8 }] },
      { g: 4.5 },
      { p: 14, lanes: [-1, 0, 1], orbs: [{ at: 5, lane: -1, y: 1.8 }, { at: 8, lane: 1, y: 1.8 }, { at: 11, lane: 0, y: 1.8 }] },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 1 }] },
      { g: 4.5 },
      { p: 14, lanes: [-1, 0, 1] },
    ],
  },
  {
    id: 6, name: 'Apex Run', seed: 606, baseSpeed: 13,
    hint: 'Everything at once, at full speed. Every gap is a decision, every wall a lane call. This is the Apex.',
    accent: '#e879f9', sky: '#1a0a2e',
    segments: [
      { p: 16, lanes: [-1, 0, 1] },
      { g: 4 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 0 }] },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: 1 }], wall: [{ at: 9, lane: -1 }] },
      { g: 5 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.0 } },
      { g: 7.5 },
      { p: 14, lanes: [-1, 0, 1], cp: true, orbs: [{ at: 5, lane: 0, y: 1.8 }, { at: 8, lane: 0, y: 1.8 }] },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 4, lane: 1 }, { at: 8, lane: 0 }] },
      { g: 5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: 0 }] },
      { g: 7 },
      { p: 12, lanes: [0], move: { amp: 1.2, period: 2.2, phase: 1.2 } },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: -1 }], over: [{ at: 9, lane: 1 }] },
      { g: 5 },
      { p: 14, lanes: [-1, 0, 1], cp: true },
      { g: 7.5 },
      { p: 14, lanes: [-1, 0, 1], orbs: [{ at: 5, lane: 1, y: 1.8 }, { at: 8, lane: -1, y: 1.8 }, { at: 11, lane: 0, y: 1.8 }] },
      { g: 4.5 },
      { p: 12, lanes: [-1, 0, 1], wall: [{ at: 6, lane: 1 }] },
      { g: 5 },
      { p: 14, lanes: [-1, 0, 1], orbs: [{ at: 5, lane: 0, y: 1.8 }, { at: 8, lane: 0, y: 1.8 }, { at: 11, lane: 0, y: 1.8 }] },
      { g: 5 },
      { p: 12, lanes: [-1, 0, 1], over: [{ at: 6, lane: -1 }] },
      { g: 5 },
      { p: 14, lanes: [-1, 0, 1] },
    ],
  },
];

export const TRACKS = TRACK_DEFS.map(buildTrack);
export function trackById(id) { return TRACKS.find((t) => t.id === id) || null; }

// Gap list for a track (derived: between consecutive platforms).
export function trackGaps(track) {
  const gaps = [];
  for (let i = 0; i < track.platforms.length - 1; i++) {
    const g = track.platforms[i + 1].s0 - track.platforms[i].s1;
    if (g > 0) gaps.push({ s0: track.platforms[i].s1, s1: track.platforms[i + 1].s0, len: g, next: track.platforms[i + 1] });
  }
  return gaps;
}

// Single-jump flight distance at speed v (airtime 2*JUMP_VEL/GRAVITY,
// trimmed 8% for takeoff/landing margin). Double-jump adds a second
// arc from the apex: total flight ~1.45s.
export function singleJumpDist(speed) { return speed * (2 * JUMP_VEL / GRAVITY) * 0.92; }
export function doubleJumpDist(speed) { return speed * 1.45 * 0.92; }

// Threat: gaps + barriers + moving platforms, weighted by speed.
export function trackThreat(track) {
  const gaps = trackGaps(track);
  const gapScore = gaps.reduce((a, g) => a + g.len, 0);
  const moving = track.platforms.filter((p) => p.move).length;
  return gapScore * 2 + track.barriers.length * 3 + moving * 6 + track.baseSpeed;
}

// --- save / best times ---
export function defaultSave() {
  return { version: SAVE_VERSION, best: {}, settings: { volume: 0.6, shake: 1, music: true, sfx: true, reduceFlashing: false, textSize: 1, highContrast: false, muted: false } };
}
export function serializeSave(save) { return JSON.stringify(save); }
export function parseSave(text) {
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object' || s.version !== SAVE_VERSION) return defaultSave();
    const d = defaultSave();
    return { version: SAVE_VERSION, best: { ...(s.best || {}) }, settings: { ...d.settings, ...(s.settings || {}) } };
  } catch { return defaultSave(); }
}
// best[trackId] = { time, score, orbs, deaths } — best time wins;
// a tie on time keeps the higher score.
export function recordBest(best, trackId, result) {
  const prev = best ? best[trackId] : null;
  if (!prev || result.time < prev.time || (result.time === prev.time && result.score > prev.score)) {
    return { ...best, [trackId]: { time: result.time, score: result.score, orbs: result.orbs, deaths: result.deaths } };
  }
  return best;
}
export function isTrackUnlocked(best, id) {
  if (id <= 1) return true;
  const prev = best ? best[id - 1] : null;
  return !!prev;
}

// ---------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------
export function createRun(track, opts = {}) {
  const run = {
    track,
    s: 2, x: 0, y: 0, vy: 0,
    lane: 0, // lane index -1, 0, 1
    laneTarget: 0,
    grounded: true, jumpsUsed: 0,
    sliding: 0, coyote: 0, jumpBuffer: 0, grace: 0,
    time: 0, speed: track.baseSpeed,
    chain: 0, maxChain: 0, perfects: 0,
    score: 0, orbs: 0, deaths: 0,
    checkpointIndex: -1,
    respawn: { s: 2, lane: 0 },
    done: false, completed: false, deathCause: null,
    events: [],
    orbsTaken: new Set(),
    wasAirborneJump: false,
  };
  return run;
}
export function startRun(track, opts = {}) { return createRun(track, opts); }

function platformAt(track, s, x, t) {
  for (const p of track.platforms) {
    if (s >= p.s0 - 0.01 && s <= p.s1 + 0.01) {
      if (Math.abs(x - platformXAt(p, t)) <= p.halfWidth + RUNNER_HALF) return p;
    }
  }
  return null;
}
function platformContainingS(track, s) {
  for (const p of track.platforms) {
    if (s >= p.s0 - 0.01 && s <= p.s1 + 0.01) return p;
  }
  return null;
}

function pushEvent(run, type, extra = {}) {
  run.events.push({ type, time: run.time, s: run.s, ...extra });
}

function die(run, cause) {
  run.deaths++;
  run.deathCause = cause;
  run.chain = 0;
  run.time += DEATH_TIME_PENALTY;
  pushEvent(run, 'death', { cause });
  // Reset to the last checkpoint (or the start line).
  run.s = run.respawn.s;
  run.x = LANES[run.respawn.lane + 1];
  run.lane = run.respawn.lane;
  run.laneTarget = run.respawn.lane;
  run.y = 0; run.vy = 0;
  run.grounded = true; run.jumpsUsed = 0;
  run.sliding = 0; run.coyote = 0; run.jumpBuffer = 0;
  run.grace = 1.0; // brief barrier immunity so a checkpoint never insta-kills
  run.wasAirborneJump = false;
}

// One fixed step. Input: { jump, slide, lane } — jump/slide are
// edge-triggered (true only on the frame pressed), lane is the desired
// lane index (-1, 0, 1) or null to hold the current lane.
export function stepRun(run, input, dt = DT) {
  if (run.done) return run;
  const track = run.track;
  run.time += dt;
  if (run.grace > 0) run.grace -= dt;

  // --- lane switching (air control allowed; x eases toward the lane) ---
  if (input.lane !== null && input.lane !== undefined && input.lane !== run.laneTarget) {
    run.laneTarget = clamp(input.lane, -1, 1);
    pushEvent(run, 'lane', { lane: run.laneTarget });
  }
  const targetX = LANES[run.laneTarget + 1];
  const dx = targetX - run.x;
  const step = LANE_SPEED * dt;
  if (Math.abs(dx) <= step) {
    run.x = targetX;
    run.lane = run.laneTarget;
  } else {
    run.x += Math.sign(dx) * step;
    // Lane snaps to the nearest lane index for state reads.
    run.lane = Math.abs(run.x - LANES[0]) < 1.2 ? 0 : (run.x < 0 ? -1 : 1);
  }

  // --- slide ---
  if (input.slide && run.grounded && run.sliding <= 0) {
    run.sliding = SLIDE_TIME;
    pushEvent(run, 'slide');
  }
  if (run.sliding > 0) run.sliding -= dt;

  // --- jump (buffered + coyote, for responsive feel) ---
  if (input.jump) run.jumpBuffer = JUMP_BUFFER;
  else if (run.jumpBuffer > 0) run.jumpBuffer -= dt;
  if (run.jumpBuffer > 0) {
    if (run.grounded || run.coyote > 0) {
      run.vy = JUMP_VEL;
      run.grounded = false;
      run.coyote = 0;
      run.jumpBuffer = 0;
      run.jumpsUsed = 1;
      run.sliding = 0;
      run.wasAirborneJump = true;
      pushEvent(run, 'jump');
    } else if (run.jumpsUsed === 1) {
      run.vy = DOUBLE_JUMP_VEL;
      run.jumpsUsed = 2;
      run.jumpBuffer = 0;
      run.sliding = 0;
      run.wasAirborneJump = true;
      pushEvent(run, 'doubleJump');
    }
  }

  // --- forward speed: base speed times the perfect-landing chain ---
  const mult = 1 + Math.min(run.chain, 8) * 0.05;
  run.speed = track.baseSpeed * mult;
  run.s += run.speed * dt;

  // --- vertical ---
  if (!run.grounded) {
    run.vy -= GRAVITY * dt;
    run.y += run.vy * dt;
    if (run.coyote > 0) run.coyote -= dt;
    if (run.y <= 0) {
      // Land only when the feet are near platform level: a runner
      // who ran off a ledge and dropped below the next platform's
      // top hits its side, not its top — they keep falling.
      const plat = run.y > -0.5 ? platformAt(track, run.s, run.x, run.time) : null;
      if (plat && run.vy <= 0) {
        // Land.
        const wasJump = run.wasAirborneJump;
        run.y = 0; run.vy = 0; run.grounded = true; run.jumpsUsed = 0;
        run.wasAirborneJump = false;
        pushEvent(run, 'land');
        if (wasJump) {
          const centre = (plat.s0 + plat.s1) / 2;
          const perfect = Math.abs(run.s - centre) <= plat.len * 0.22
            && Math.abs(run.x - platformXAt(plat, run.time)) <= 0.8;
          if (perfect) {
            run.chain++;
            run.maxChain = Math.max(run.maxChain, run.chain);
            run.perfects++;
            const pts = PERFECT_BASE + PERFECT_STEP * run.chain;
            run.score += pts;
            pushEvent(run, 'perfect', { chain: run.chain, points: pts });
          } else {
            run.chain = 0;
          }
        }
      } else if (run.y < VOID_Y) {
        die(run, 'void');
        return run;
      }
    }
  } else {
    // Grounded: still on a platform?
    const plat = platformAt(track, run.s, run.x, run.time);
    if (!plat) {
      run.grounded = false;
      run.vy = 0;
      run.coyote = COYOTE_TIME;
    }
  }

  // --- barriers (skipped during respawn grace) ---
  if (run.grace <= 0) {
    const height = run.sliding > 0 ? SLIDE_HEIGHT : RUNNER_HEIGHT;
    for (const b of track.barriers) {
      if (Math.abs(run.s - b.s) > 0.7) continue;
      if (Math.abs(run.x - LANES[b.lane + 1]) > 1.3) continue;
      if (b.kind === 'wall') {
        if (run.y < WALL_HEIGHT - 0.2) { die(run, 'wall'); return run; }
      } else if (b.kind === 'over') {
        // The bar hangs from y=1.0 up: a slide (0.8 high) passes
        // under it; standing or jumping always clips it.
        if (run.y + height > OVER_BOTTOM && run.y < OVER_TOP) { die(run, 'barrier'); return run; }
      }
    }
  }

  // --- orbs ---
  for (const o of track.orbs) {
    if (run.orbsTaken.has(o)) continue;
    if (Math.abs(run.s - o.s) > 1.0) continue;
    if (Math.abs(run.x - LANES[o.lane + 1]) > 1.1) continue;
    if (Math.abs(run.y - o.y) > 1.3) continue;
    run.orbsTaken.add(o);
    run.orbs++;
    run.score += ORB_SCORE;
    pushEvent(run, 'orb', { lane: o.lane });
  }

  // --- checkpoints ---
  for (let i = 0; i < track.checkpoints.length; i++) {
    const cp = track.checkpoints[i];
    if (i > run.checkpointIndex && run.s >= cp.s) {
      run.checkpointIndex = i;
      run.respawn = { s: cp.s, lane: run.lane };
      run.score += CHECKPOINT_SCORE;
      pushEvent(run, 'checkpoint', { index: i });
    }
  }

  // --- finish ---
  if (run.s >= track.finishS) {
    run.done = true;
    run.completed = true;
    const timeBonus = Math.max(0, Math.round((track.par - run.time) * 25));
    run.score += timeBonus;
    pushEvent(run, 'finish', { time: run.time, timeBonus });
  }
  return run;
}

// Drain the event queue (game.js consumes these once per frame).
export function drainEvents(run) {
  const ev = run.events;
  run.events = [];
  return ev;
}

// ---------------------------------------------------------------------
// Policies (bots play through the same stepRun + input hooks)
// ---------------------------------------------------------------------
export function noInputPolicy() {
  return { jump: false, slide: false, lane: null };
}

export function randomPolicy(seed = 7) {
  const rng = mulberry32(seed);
  return function () {
    const r = rng();
    let lane = null;
    if (r < 0.012) lane = Math.floor(rng() * 3) - 1;
    return {
      jump: rng() < 0.012,
      slide: rng() < 0.008,
      lane,
    };
  };
}

// The decision bot: real timing decisions, no cheats — it only reads
// the runner state and the track layout ahead, exactly what a player
// sees. Jump at the platform edge (single or double as the gap
// demands), slide under overhead bars, switch lanes for walls, steer
// toward orb lines when it is safe.
//
// Lane priority (a later rule never overrides an earlier one):
//   1. wall avoidance — a wall in our lane forces a switch now
//   2. next-platform coverage — line up a lane the next platform covers
//   3. orb lines — only when nothing urgent is happening
// In particular the moving-platform "hold lane 0" rule never fires
// while a wall or overhead bar is still ahead in lane 0: switching
// into a hazard to prepare for the next platform is how a bot dies
// on a bar it could have walked past in another lane.
function laneHasWallAhead(track, run, lane, dist) {
  return track.barriers.some((b) => b.kind === 'wall' && b.lane === lane && b.s > run.s && b.s - run.s < dist);
}
function laneHasOverAhead(track, run, lane, dist) {
  return track.barriers.some((b) => b.kind === 'over' && b.lane === lane && b.s > run.s && b.s - run.s < dist);
}

export function decisionPolicy(track, run) {
  const speed = run.speed;
  const cur = platformContainingS(track, run.s);
  const gaps = trackGaps(track);
  let laneTarget = run.laneTarget;
  let jump = false;
  let slide = false;

  // --- 1. walls: switch out of a walled lane before reaching it ---
  let wallLane = null;
  for (const b of track.barriers) {
    if (b.kind !== 'wall') continue;
    const d = b.s - run.s;
    if (d <= 0 || d > speed * 0.9) continue;
    if (Math.abs(run.x - LANES[b.lane + 1]) > 1.3) continue; // not in the walled lane
    // Pick the adjacent lane with no wall near this barrier and a
    // platform under it at the barrier's s.
    const options = [b.lane - 1, b.lane + 1].filter((l) => l >= -1 && l <= 1);
    for (const l of options) {
      const blocked = track.barriers.some((b2) => b2.kind === 'wall' && b2.lane === l && Math.abs(b2.s - b.s) < 2.5);
      const plat = platformContainingS(track, b.s);
      const covered = plat && Math.abs(LANES[l + 1] - platformXAt(plat, run.time)) <= plat.halfWidth + RUNNER_HALF;
      if (!blocked && covered) { wallLane = l; break; }
    }
    break; // only the nearest wall matters
  }
  if (wallLane !== null) laneTarget = wallLane;

  // --- 2. next platform: line up a lane it covers before the jump ---
  let nextPlat = null;
  if (cur) {
    for (const p of track.platforms) {
      if (p.s0 >= cur.s1 - 0.01) { nextPlat = p; break; }
    }
  }
  if (wallLane === null && cur && nextPlat) {
    const distToEdge = cur.s1 - run.s;
    if (distToEdge < speed * 0.6) {
      // Static next platform: line up a lane it covers. (Moving
      // next platforms are handled by the lane-0 rule below — a
      // snapshot of a swinging platform's coverage is the wrong
      // basis for a switch, and switching across a bar's lane to
      // reach a "covered" lane is how the bot dies mid-switch.)
      if (!nextPlat.move) {
        const coveredLanes = [-1, 0, 1].filter((l) => {
          const px = platformXAt(nextPlat, run.time + 0.4);
          return Math.abs(LANES[l + 1] - px) <= nextPlat.halfWidth + RUNNER_HALF;
        }).filter((l) => !laneHasWallAhead(track, run, l, speed * 1.2)
          // Never switch INTO an overhead bar: crossing it mid-switch
          // leaves no grounded frame to slide under it.
          && !laneHasOverAhead(track, run, l, speed * 0.9));
        if (coveredLanes.length && !coveredLanes.includes(run.laneTarget)) {
          // Prefer the lane the runner is already nearest to.
          coveredLanes.sort((a, b) => Math.abs(LANES[a + 1] - run.x) - Math.abs(LANES[b + 1] - run.x));
          laneTarget = coveredLanes[0];
        }
      }
      // Moving platform: lane 0 is always covered (wide platform,
      // small sway) — hold centre, but NEVER switch into a wall or
      // overhead bar that is still ahead on this platform.
      if (nextPlat.move && !laneHasWallAhead(track, run, 0, speed * 0.9)
        && !laneHasOverAhead(track, run, 0, speed * 0.9)) {
        laneTarget = 0;
      }
    }
  }

  // --- 3. orbs: steer toward a safe orb line when nothing urgent ---
  if (wallLane === null && cur && nextPlat) {
    const distToEdge = cur.s1 - run.s;
    if (distToEdge > speed * 0.9) {
      for (const o of track.orbs) {
        if (run.orbsTaken.has(o)) continue;
        const d = o.s - run.s;
        if (d <= 0 || d > 15) continue;
        if (o.lane === run.laneTarget) break;
        const hazard = track.barriers.some((b) => b.lane === o.lane && Math.abs(b.s - o.s) < 3);
        if (!hazard) { laneTarget = o.lane; break; }
      }
    }
  }

  // Never walk off a moving platform: if grounded on one and the
  // desired lane is not covered by it right now, hold the current
  // lane — the switch resumes in the air, where lateral movement
  // needs no support. (Without this the bot switches toward a wall
  // while the platform swings away underneath it, loses support,
  // and falls into the gap before it can jump.)
  if (run.grounded && cur && cur.move) {
    const px = platformXAt(cur, run.time);
    if (Math.abs(LANES[laneTarget + 1] - px) > cur.halfWidth + RUNNER_HALF) {
      laneTarget = run.laneTarget;
    }
  }

  // --- jumping: at the edge, sized to the gap ---
  // The lane switch keeps running in the air (air control), so the
  // jump must NOT wait for the switch to settle — waiting is what
  // runs the bot off the edge right before a wall platform. The
  // lane logic above already picked a lane the next platform
  // covers, and walls sit >= 4u past a platform start, so the
  // switch finishes long before the wall is reached.
  if ((run.grounded || run.coyote > 0) && cur && nextPlat) {
    const gap = nextPlat.s0 - cur.s1;
    if (gap > 0) {
      const distToEdge = cur.s1 - run.s;
      const edgeNow = distToEdge <= 0.4 + speed * 0.02;
      if (edgeNow) jump = true;
    }
  }

  // --- orb jumps: a jump-orb in our lane is worth a hop, when
  // there is landing room and no gap or hazard imminent ---
  if (!jump && run.grounded && cur) {
    for (const o of track.orbs) {
      if (run.orbsTaken.has(o) || o.y < 1) continue;
      if (o.lane !== run.laneTarget) continue;
      const d = o.s - run.s;
      if (d <= 0 || d > speed * 0.45) continue;
      // Landing room: the jump carries ~0.77s of flight.
      if (cur.s1 - run.s < speed * 0.85) continue;
      // No gap edge or barrier in this lane before we land.
      const hazard = track.barriers.some((b) => b.lane === run.laneTarget && b.s > run.s && b.s - run.s < speed * 0.85);
      if (hazard) continue;
      jump = true;
      break;
    }
  }

  // --- double jump: only when the single arc would fall short ---
  if (!run.grounded && run.jumpsUsed === 1 && run.vy < 3 && run.vy > -2) {
    const gap = gaps.find((g) => run.s >= g.s0 - speed * 0.2 && run.s < g.s1);
    if (gap) {
      // Time left falling to y=0 without a second jump.
      const tFall = (run.vy + Math.sqrt(Math.max(0, run.vy * run.vy + 2 * GRAVITY * Math.max(0, run.y)))) / GRAVITY;
      const landS = run.s + run.speed * tFall;
      if (landS < gap.s1 + 0.5) jump = true;
    }
  }

  // --- sliding: an overhead bar in our lane, timed to the slide ---
  if (run.grounded && run.sliding <= 0) {
    for (const b of track.barriers) {
      if (b.kind !== 'over') continue;
      const d = b.s - run.s;
      if (d <= 0 || d > speed * 0.32) continue;
      if (Math.abs(run.x - LANES[b.lane + 1]) > 1.3) continue;
      slide = true;
      break;
    }
  }

  return { jump, slide, lane: laneTarget };
}

// Run a whole track with a policy. Returns a summary; `policy` is
// either a function (run, track) => input or a factory returning one.
export function simulateRun(track, policy, opts = {}) {
  const run = startRun(track, opts);
  const makePolicy = typeof policy === 'function' && policy.length <= 1
    ? null : policy;
  let stepPolicy;
  if (typeof policy === 'function') {
    // decisionPolicy takes (track, run); randomPolicy/noInput take ().
    stepPolicy = policy.length >= 2
      ? () => policy(track, run)
      : policy;
  } else {
    stepPolicy = () => ({ jump: false, slide: false, lane: null });
  }
  void makePolicy;
  const maxSteps = Math.ceil((opts.maxTime || 300) / DT);
  const maxDeaths = opts.maxDeaths === undefined ? Infinity : opts.maxDeaths;
  let steps = 0;
  while (!run.done && steps < maxSteps && run.deaths <= maxDeaths) {
    stepRun(run, stepPolicy(), DT);
    steps++;
  }
  return {
    completed: run.completed,
    time: run.time,
    score: run.score,
    orbs: run.orbs,
    deaths: run.deaths,
    maxChain: run.maxChain,
    perfects: run.perfects,
    checkpoints: run.checkpointIndex + 1,
    s: run.s,
    steps,
    deathCause: run.deathCause,
  };
}
