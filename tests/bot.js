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
