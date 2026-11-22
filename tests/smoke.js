// Neon Apex v0.1.0 — Node smoke tests for physics.js (no DOM, no Three.js).
import {
  VERSION, TRACKS, trackById, trackGaps, trackThreat, singleJumpDist, doubleJumpDist,
  LANES, DT, GRAVITY, JUMP_VEL, DOUBLE_JUMP_VEL, SLIDE_TIME, VOID_Y,
  createRun, startRun, stepRun, simulateRun, noInputPolicy, randomPolicy, decisionPolicy,
  platformXAt, clamp, mulberry32,
  FEEDBACK, FEEDBACK_TIERS, FEEDBACK_LAYERS,
  defaultSave, serializeSave, parseSave, recordBest, isTrackUnlocked,
  ORB_SCORE, PERFECT_BASE, PERFECT_STEP,
} from '../physics.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed++;
  else { failed++; failures.push(name); console.error('FAIL:', name); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

check('physics version is 0.1.0', VERSION === '0.1.0');
check('6 tracks defined', TRACKS.length === 6);
check('track ids are 1..6 in order', TRACKS.every((t, i) => t.id === i + 1));
check('every track has a name and a hint', TRACKS.every((t) => t.name && t.hint));
check('every track has a distinct accent', new Set(TRACKS.map((t) => t.accent)).size === 6);
check('trackById finds track 1', trackById(1) && trackById(1).name === 'First Steps');
check('trackById finds track 4', trackById(4) && trackById(4).name === 'Skyline Sprint');
check('trackById finds track 6', trackById(6) && trackById(6).name === 'Apex Run');
check('trackById returns null for unknown id', trackById(99) === null);
check('every track has 10+ platforms', TRACKS.every((t) => t.platforms.length >= 10));
check('every track is dense (190+ units long)', TRACKS.every((t) => t.length >= 190));
check('every track has 2+ checkpoints', TRACKS.every((t) => t.checkpoints.length >= 2));
check('every track has 6+ orbs', TRACKS.every((t) => t.orbs.length >= 6));
check('every track has barriers', TRACKS.every((t) => t.barriers.length >= 2));
check('every track has a finish past the last checkpoint',
  TRACKS.every((t) => t.finishS > t.checkpoints[t.checkpoints.length - 1].s));
check('threat grows with track number', TRACKS.every((t, i) => i === 0 || trackThreat(t) > trackThreat(TRACKS[i - 1])));
check('no difficulty cliff: each track within 1.6x of the previous threat',
  TRACKS.every((t, i) => i === 0 || trackThreat(t) <= trackThreat(TRACKS[i - 1]) * 1.6));
check('tracks 2+ introduce walls', TRACKS.slice(1).every((t) => t.barriers.some((b) => b.kind === 'wall')));
check('tracks 1+ introduce overhead bars', TRACKS.every((t) => t.barriers.some((b) => b.kind === 'over')));
check('tracks 4+ introduce moving platforms', TRACKS.slice(3).every((t) => t.platforms.some((p) => p.move)));
check('tracks 1-3 have no moving platforms (movement is taught in T4)',
  TRACKS.slice(0, 3).every((t) => !t.platforms.some((p) => p.move)));
check('track 1 teaches: first gap is small (<= 3.5)', trackGaps(TRACKS[0])[0].len <= 3.5);
check('first platform covers all lanes on every track',
  TRACKS.every((t) => t.platforms[0].lanes.length === 3));
check('first seconds survivable: first gap starts at least 14u in',
  TRACKS.every((t) => trackGaps(t)[0].s0 >= 14));

// --- gap jumpability: every gap inside the double-jump envelope ---
for (const t of TRACKS) {
  for (const g of trackGaps(t)) {
    check(`T${t.id} gap ${g.len} is double-jumpable at speed ${t.baseSpeed}`, g.len <= doubleJumpDist(t.baseSpeed) * 0.85);
  }
}
// Gaps that need the double jump only appear on T4+ (double jump is
// taught there, on a wide safe gap, before it is ever required).
for (const t of TRACKS.slice(0, 3)) {
  for (const g of trackGaps(t)) {
    check(`T${t.id} gap ${g.len} is single-jumpable (no double jump required before T4)`, g.len <= singleJumpDist(t.baseSpeed) * 0.95);
  }
}

// --- every wall has a free adjacent lane with a platform under it ---
for (const t of TRACKS) {
  for (const b of t.barriers.filter((x) => x.kind === 'wall')) {
    const options = [b.lane - 1, b.lane + 1].filter((l) => l >= -1 && l <= 1);
    const escape = options.some((l) => {
      const blocked = t.barriers.some((b2) => b2.kind === 'wall' && b2.lane === l && Math.abs(b2.s - b.s) < 2.5);
      const plat = t.platforms.find((p) => b.s >= p.s0 && b.s <= p.s1);
      const covered = plat && Math.abs(LANES[l + 1] - plat.baseX) <= plat.halfWidth + 0.4;
      return !blocked && covered;
    });
    check(`T${t.id} wall at s=${b.s.toFixed(0)} lane ${b.lane} has a free adjacent lane`, escape);
  }
}
// --- every orb sits over a platform (collectable) ---
for (const t of TRACKS) {
  for (const o of t.orbs) {
    const plat = t.platforms.find((p) => o.s >= p.s0 && o.s <= p.s1);
    check(`T${t.id} orb at s=${o.s.toFixed(0)} is over a platform`, !!plat);
  }
}
// --- every checkpoint sits on a platform ---
for (const t of TRACKS) {
  for (const cp of t.checkpoints) {
    const plat = t.platforms.find((p) => cp.s >= p.s0 && cp.s <= p.s1);
    check(`T${t.id} checkpoint at s=${cp.s.toFixed(0)} is on a platform`, !!plat);
  }
}
// --- moving platforms always cover lane 0 (the safe lane) ---
for (const t of TRACKS) {
  for (const p of t.platforms.filter((x) => x.move)) {
    let covers = true;
    for (let tt = 0; tt < p.move.period; tt += 0.1) {
      if (Math.abs(0 - platformXAt(p, tt)) > p.halfWidth + 0.4) covers = false;
    }
    check(`T${t.id} moving platform at s=${p.s0.toFixed(0)} always covers lane 0`, covers);
  }
}

// --- helpers ---
check('mulberry32 is deterministic', mulberry32(42)() === mulberry32(42)());
check('clamp clamps', clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2);
check('single jump distance grows with speed', singleJumpDist(13) > singleJumpDist(10));
check('double jump outranges single jump', doubleJumpDist(11) > singleJumpDist(11));

// --- feedback contract: every event has a tier in range and 5+ layers ---
for (const [name, fb] of Object.entries(FEEDBACK)) {
  const tier = FEEDBACK_TIERS[fb.tier];
  check(`feedback ${name} trauma inside its tier`, fb.trauma >= tier.traumaMin && fb.trauma <= tier.traumaMax);
  check(`feedback ${name} hit-stop inside its tier`, fb.hitStop >= tier.stopMin && fb.hitStop <= tier.stopMax);
  check(`feedback ${name} has 5+ layers`, (FEEDBACK_LAYERS[name] || []).length >= 5);
}

// --- run state: start, run forward, jump, land ---
{
  const run = startRun(TRACKS[0]);
  check('run starts on solid ground, lane 0, s=2', run.grounded && run.lane === 0 && run.s === 2);
  check('run starts with 0 score/orbs/deaths', run.score === 0 && run.orbs === 0 && run.deaths === 0);
  check('run is not done at start', !run.done && !run.completed);
  // No input: the runner sprints forward off the first gap and dies in the void.
  const still = simulateRun(TRACKS[0], noInputPolicy);
  check('no input dies in the void (no auto-play)', !still.completed && still.deaths >= 1 && still.deathCause === 'void');
}
{
  // Jump happens the instant the player presses: vy is set on the same step.
  const run = startRun(TRACKS[0]);
  stepRun(run, { jump: true, slide: false, lane: null }, DT);
  check('jump sets vertical velocity immediately', run.vy > 0 && !run.grounded);
  check('jump velocity is the jump constant', approx(run.vy, JUMP_VEL - GRAVITY * DT, 1e-6));
  // Momentum carries through the jump: s keeps increasing while airborne.
  const s0 = run.s;
  for (let i = 0; i < 60; i++) stepRun(run, { jump: false, slide: false, lane: null }, DT);
  check('momentum carries through the jump (s keeps increasing)', run.s > s0 + 2);
  check('runner lands back on the start platform', run.grounded && run.y === 0);
}
{
  // Double jump: second press in the air gives a fresh upward velocity.
  const run = startRun(TRACKS[0]);
  stepRun(run, { jump: true, slide: false, lane: null }, DT);
  for (let i = 0; i < 20; i++) stepRun(run, { jump: false, slide: false, lane: null }, DT);
  const vyBefore = run.vy;
  check('runner is falling or near apex before the double jump', vyBefore < 4);
  stepRun(run, { jump: true, slide: false, lane: null }, DT);
  check('double jump refreshes upward velocity', run.vy > vyBefore && run.vy > 8);
  check('double jump is consumed (no third jump)', run.jumpsUsed === 2);
  stepRun(run, { jump: true, slide: false, lane: null }, DT);
  check('third jump press does nothing', run.jumpsUsed === 2);
}
{
  // Lane switching: x eases toward the target lane at LANE_SPEED.
  const run = startRun(TRACKS[0]);
  const x0 = run.x;
  stepRun(run, { jump: false, slide: false, lane: -1 }, DT);
  check('lane switch starts moving the runner left', run.x < x0);
  for (let i = 0; i < 40; i++) stepRun(run, { jump: false, slide: false, lane: -1 }, DT);
  check('lane switch arrives at lane -1', run.lane === -1 && approx(run.x, LANES[0], 1e-6));
}
{
  // Slide: lasts SLIDE_TIME, then ends on its own.
  const run = startRun(TRACKS[0]);
  stepRun(run, { jump: false, slide: true, lane: null }, DT);
  check('slide starts', run.sliding > 0);
  const dur = run.sliding;
  check('slide duration is the slide constant', approx(dur, SLIDE_TIME - DT, 1e-6));
  for (let i = 0; i < 40; i++) stepRun(run, { jump: false, slide: false, lane: null }, DT);
  check('slide ends by itself', run.sliding <= 0);
}
{
  // A standing runner dies on a wall; a runner in another lane passes.
  const t = TRACKS[0];
  const wall = t.barriers.find((b) => b.kind === 'wall');
  const run = startRun(t);
  run.s = wall.s - 0.5; run.x = LANES[wall.lane + 1]; run.lane = wall.lane; run.laneTarget = wall.lane;
  stepRun(run, { jump: false, slide: false, lane: null }, DT);
  check('wall kills a runner in its lane', run.deaths === 1 && run.deathCause === 'wall');
  check('death resets to the start (no checkpoint reached yet)', run.s === 2);
  const run2 = startRun(t);
  run2.s = wall.s - 0.5;
  run2.x = LANES[(wall.lane === 0 ? 1 : 0) + 1]; run2.lane = wall.lane === 0 ? 1 : 0; run2.laneTarget = run2.lane;
  stepRun(run2, { jump: false, slide: false, lane: null }, DT);
  check('wall does not kill a runner in another lane', run2.deaths === 0);
}
{
  // An overhead bar kills a standing runner, but not a sliding one.
  const t = TRACKS[0];
  const over = t.barriers.find((b) => b.kind === 'over');
  const run = startRun(t);
  run.s = over.s - 0.5; run.x = LANES[over.lane + 1]; run.lane = over.lane; run.laneTarget = over.lane;
  stepRun(run, { jump: false, slide: false, lane: null }, DT);
  check('overhead bar kills a standing runner', run.deaths === 1 && run.deathCause === 'barrier');
  const run2 = startRun(t);
  run2.s = over.s - 0.5; run2.x = LANES[over.lane + 1]; run2.lane = over.lane; run2.laneTarget = over.lane;
  stepRun(run2, { jump: false, slide: true, lane: null }, DT);
  check('sliding under an overhead bar is safe', run2.deaths === 0);
  // Jumping through an overhead bar also kills (the bar hangs to y=3).
  const run3 = startRun(t);
  run3.s = over.s - 0.5; run3.x = LANES[over.lane + 1]; run3.lane = over.lane; run3.laneTarget = over.lane;
  run3.y = 1.5; run3.vy = 2; run3.grounded = false; run3.jumpsUsed = 1;
  stepRun(run3, { jump: false, slide: false, lane: null }, DT);
  check('jumping through an overhead bar kills (must slide)', run3.deaths === 1);
}
{
  // Orbs: ground orb collected by running through; jump orb needs air.
  const t = TRACKS[0];
  const orb = t.orbs.find((o) => o.y === 0);
  const run = startRun(t);
  run.s = orb.s - 0.5; run.x = LANES[orb.lane + 1]; run.lane = orb.lane; run.laneTarget = orb.lane;
  stepRun(run, { jump: false, slide: false, lane: null }, DT);
  check('ground orb collected on the run', run.orbs === 1 && run.score === ORB_SCORE);
  const jumpOrb = t.orbs.find((o) => o.y === 1.8);
  const run2 = startRun(t);
  run2.s = jumpOrb.s - 0.5; run2.x = LANES[jumpOrb.lane + 1]; run2.lane = jumpOrb.lane; run2.laneTarget = jumpOrb.lane;
  stepRun(run2, { jump: false, slide: false, lane: null }, DT);
  check('jump orb is NOT collected on the ground', run2.orbs === 0);
  const run3 = startRun(t);
  run3.s = jumpOrb.s - 0.5; run3.x = LANES[jumpOrb.lane + 1]; run3.lane = jumpOrb.lane; run3.laneTarget = jumpOrb.lane;
  run3.y = 1.8; run3.vy = 0; run3.grounded = false; run3.jumpsUsed = 1;
  stepRun(run3, { jump: false, slide: false, lane: null }, DT);
  check('jump orb IS collected mid-jump', run3.orbs === 1);
}
{
  // Checkpoints: passing one moves the respawn; death returns there.
  const t = TRACKS[0];
  const cp = t.checkpoints[0];
  const run = startRun(t);
  run.s = cp.s - 0.5;
  for (let i = 0; i < 10 && run.s < cp.s; i++) stepRun(run, { jump: false, slide: false, lane: null }, DT);
  check('checkpoint reached', run.checkpointIndex === 0 && run.respawn.s === cp.s);
  check('checkpoint scores', run.score >= 25);
  run.y = VOID_Y - 1; run.vy = -5; run.grounded = false;
  stepRun(run, { jump: false, slide: false, lane: null }, DT);
  check('void death after a checkpoint respawns at the checkpoint', run.deaths === 1 && run.s === cp.s);
}
{
  // Perfect landing: a jump that lands near a platform centre chains.
  const t = TRACKS[0];
  const run = startRun(t);
  // Jump the first gap and land dead-centre of platform 2 by hand:
  // take off at the edge, land near the centre — the sim decides.
  const sim = simulateRun(t, decisionPolicy);
  check('decision bot chains perfect landings', sim.perfects >= 3);
  check('decision bot builds a chain', sim.maxChain >= 2);
  check('perfect landings score', sim.score > sim.orbs * ORB_SCORE);
}

// --- save / best ---
{
  const save = defaultSave();
  check('default save has no bests', Object.keys(save.best).length === 0);
  check('save round-trips', parseSave(serializeSave(save)).version === 1);
  check('corrupt save falls back to defaults', parseSave('not json').version === 1);
  check('old-version save falls back to defaults', parseSave(JSON.stringify({ version: 99 })).version === 1);
  let best = recordBest({}, 1, { time: 30, score: 1000, orbs: 9, deaths: 0 });
  check('best recorded', best[1].time === 30 && best[1].score === 1000);
  best = recordBest(best, 1, { time: 32, score: 5000, orbs: 9, deaths: 0 });
  check('slower time does not replace the best', best[1].time === 30);
  best = recordBest(best, 1, { time: 28, score: 800, orbs: 9, deaths: 1 });
  check('faster time replaces the best', best[1].time === 28);
  check('track 1 unlocked on a fresh save', isTrackUnlocked({}, 1));
  check('track 2 locked on a fresh save', !isTrackUnlocked({}, 2));
  check('track 2 unlocks when track 1 has a best', isTrackUnlocked({ 1: { time: 30 } }, 2));
  check('track 3 stays locked when only track 1 is cleared', !isTrackUnlocked({ 1: { time: 30 } }, 3));
}

if (failed) {
  console.error(`smoke: ${failed} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`smoke: PASS — ${passed} checks passed, 0 failed`);
