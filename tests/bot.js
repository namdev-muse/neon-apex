// Neon Apex v0.3.1 — bot harness: the decision bot plays every
// track to completion through the public stepRun + policy hooks, and
// the anti-slop gate asserts a bot that jumps/slides/switches lanes
// at RANDOM cannot finish any track on 5 lives — random flailing
// dies over and over (checkpoints let it retry, so the gate is the
// lives budget, not a single death). A bot that does nothing also
// dies everywhere (no auto-play). The decision bot must finish clean.
import { TRACKS, simulateRun, noInputPolicy, randomPolicy, decisionPolicy } from '../physics.js';

let failures = 0;
for (const track of TRACKS) {
  const bot = simulateRun(track, decisionPolicy);
  const rand = simulateRun(track, randomPolicy(1000 + track.id), { maxDeaths: 5 });
  const rand2 = simulateRun(track, randomPolicy(2000 + track.id), { maxDeaths: 5 });
  const randFree = simulateRun(track, randomPolicy(1000 + track.id));
  const still = simulateRun(track, noInputPolicy);
  console.log(`Track ${track.id} "${track.name}": decision bot ${bot.completed ? 'COMPLETE' : 'FAILED'}`
    + ` in ${bot.time.toFixed(1)}s (par ${track.par}s), score ${bot.score}`
    + ` (${bot.orbs}/${track.orbCount} orbs, ${bot.perfects} perfects, max chain x${bot.maxChain},`
    + ` ${bot.deaths} deaths, ${bot.checkpoints}/${track.checkpoints.length} checkpoints)`
    + ` | random (5 lives): ${rand.completed ? 'CLEARED (SLOP!)' : `failed after ${rand.deaths} deaths`} / ${rand2.completed ? 'CLEARED (SLOP!)' : `failed after ${rand2.deaths} deaths`}`
    + ` (unlimited: ${randFree.completed ? `cleared in ${randFree.time.toFixed(0)}s with ${randFree.deaths} deaths` : 'failed'})`
    + ` | no-input: ${still.completed ? 'CLEARED (SLOP!)' : `died (${still.deathCause})`}`);
  if (!bot.completed) { failures++; console.error(`  BOT FAIL: track ${track.id} not completed by the decision bot`); }
  if (bot.deaths > 2) { failures++; console.error(`  BOT FAIL: track ${track.id} decision bot died ${bot.deaths} times (want <= 2 — the bot should play clean)`); }
  if (bot.perfects < 2) { failures++; console.error(`  BOT FAIL: track ${track.id} decision bot landed only ${bot.perfects} perfects (want 2+ — the chain is the core)`); }
  if (bot.orbs === 0) { failures++; console.error(`  BOT FAIL: track ${track.id} decision bot collected no orbs`); }
  if (rand.completed || rand2.completed) { failures++; console.error(`  BOT FAIL: track ${track.id} is clearable by random inputs on 5 lives — tighten the track`); }
  if (still.completed) { failures++; console.error(`  BOT FAIL: track ${track.id} is clearable with no input — the runner must not auto-play`); }
}

if (failures) { console.error(`bot: ${failures} failure(s)`); process.exit(1); }
console.log(`bot: PASS — decision bot completes all ${TRACKS.length} tracks, random bots fail all ${TRACKS.length} on 5 lives (2 seeds each), no-input dies on all ${TRACKS.length}`);

// --- M4: Time Attack gate ---
// The decision bot must clear every track in Time Attack with 0
// deaths (the mode is completable by good play). A bot that plays
// Time Attack the way a normal-mode player plays — never steering
// for orbs, never jumping for jump orbs — must run dry on the
// orb-sparse tracks (T2–T6), proving the clock is fuelled by orbs
// and not by the starting budget. Random inputs must fail TA too.
function orbBlindPolicy(track, run, opts) {
  return decisionPolicy(track, run, { ...opts, ignoreOrbs: true });
}
let taFailures = 0;
let blindFails = 0;
for (const track of TRACKS) {
  const ta = simulateRun(track, decisionPolicy, { mode: 'ta' });
  const blind = simulateRun(track, orbBlindPolicy, { mode: 'ta' });
  const rand = simulateRun(track, randomPolicy(1000 + track.id), { mode: 'ta', maxDeaths: 5 });
  console.log(`TA Track ${track.id}: decision ${ta.completed ? `CLEAR clock ${ta.clock.toFixed(1)}s left` : 'FAILED'}`
    + ` (${ta.orbs}/${track.orbCount} orbs, ${ta.deaths} deaths)`
    + ` | orb-blind ${blind.completed ? `cleared (clock ${blind.clock.toFixed(1)})` : 'ran dry'}`
    + ` | random ${rand.completed ? 'CLEARED (SLOP!)' : 'failed'}`);
  if (!ta.completed) { taFailures++; console.error(`  TA BOT FAIL: track ${track.id} not completed by the decision bot in Time Attack`); }
  if (ta.deaths > 0) { taFailures++; console.error(`  TA BOT FAIL: track ${track.id} decision bot died ${ta.deaths} times in Time Attack (want 0)`); }
  if (!blind.completed) blindFails++;
  if (rand.completed) { taFailures++; console.error(`  TA BOT FAIL: track ${track.id} clearable by random inputs in Time Attack`); }
}
if (blindFails < 4) { taFailures++; console.error(`  TA BOT FAIL: orb-blind bot failed only ${blindFails}/12 tracks in Time Attack (want 4+ — orbs must be the fuel)`); }
if (taFailures) { console.error(`bot (Time Attack): ${taFailures} failure(s)`); process.exit(1); }
console.log(`bot (Time Attack): PASS — decision bot clears all ${TRACKS.length} tracks with 0 deaths, orb-blind bot runs dry on ${blindFails}/${TRACKS.length}, random fails all ${TRACKS.length}`);
