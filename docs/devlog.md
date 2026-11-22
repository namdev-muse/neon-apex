# Neon Apex — devlog

## M2 track craft — v0.2.0 (2026-11-22)

Six new hand-crafted tracks (T7–T12, 280–392 units each) with distinct
identities, difficulty curve tuned by threat (93 → 338, every step
monotonic, ratios 1.02–1.35, no cliff): Golden Mile (orb-heavy, 21
orbs), Slalom City (wall slalom), Low Ceiling (slide chains, double
bars), Drift Fields (moving platforms, wide 1.4 sway), Double Trouble
(long gaps 7–10.5u), Apex Prime (everything at speed 16, three
checkpoints). M1 carry-overs fixed: overhead bars are now orange
hanging beams on posts with a slide-gap underneath (walls stay solid
magenta — the two verbs finally read differently); wall meshes widened
2.3 → 2.6 to match the physics hitbox exactly; fog 0.010 → 0.007 so
the track ahead reads further; T1 teaches the wall before the first
checkpoint and its finish slalom gaps softened 3.5 → 3. Menu track grid
is 3 columns now (12 cards fit at 1280x720 without scrolling).

**Bot findings while building the tracks**

- T8 died once in the first bot run: a wall on the checkpoint
  platform sat in lane 0 exactly where the orb line in lane 1 pulled
  the runner across — an unfair compound (a human pre-positioning for
  the next platform's slalom would die the same way). Fixed by
  moving the orbs to lane -1, then removing the wall outright: the
  bot's lane rules (escape-wall vs line-up-next-platform) flip-flopped
  across the |x| = 1.3 boundary while crossing the wall lane.
  Lesson: never put a wall in the lane a player must cross to set up
  for the next platform.
- Decision bot now clears all 12 with 0 deaths; random bots fail all
  12 on 5 lives; no-input dies everywhere. Smoke 565 checks.

## M1 core — v0.1.0 (2026-11-22, local tree only)

Game #7, first 3D game of the next loop (games #7–#9 are 3D, #10 is 2D).
Built by the Neon Flux finale run as a local tree; repo creation and
first push follow at the 13:30 milestone run.

**What shipped**

- Run / jump / double-jump / slide / lane-switch with momentum
  (buffered jump + coyote time), void falls + barrier hits, energy
  orbs (ground + jump lines), checkpoints, finish gate, perfect-landing
  chain with speed multiplier, score + best times per track.
- 6 dense hand-crafted tracks with distinct identities (First Steps,
  Neon Steps, Magenta Maze, Skyline Sprint, Void Waltz, Apex Run),
  195–268 units each, 12–15 platforms, 2 checkpoints per track.
- Live 3D menu (attract demo: the decision bot plays track 1 behind
  the menu), screen-stack UI, one primary Play action, track cards
  with lock gates, staggered overshoot pops, hover tick SFX + scale
  pop + press feedback, no version/engine text player-facing.
- Game feel per the threejs skill: trauma shake tiers, hit-stop,
  death slow-mo, pooled particles (instanced), trail, FOV kick with
  speed, squash & stretch, Web Audio synth SFX + step-sequencer music.
- Tests: smoke (315 checks), bot harness (decision bot + random-bot
  anti-slop gate on 5 lives), headless render check, screenshots +
  3-resolution size sweep.

**Sim bugs found and fixed while building the bot**

- Landing check let the runner "land" from below platform level
  (falling into a gap and snapping up onto the next platform). Now
  lands only when the feet are within 0.5u of platform level.
- The bot blocked its own jump while a lane switch was settling and
  ran off gap edges. Jump no longer waits for the switch (air
  control finishes it).
- The moving-platform "hold lane 0" rule fired while a wall/bar was
  still ahead on the current platform and steered the bot into it.
  Hazard avoidance now outranks it, with wall/over vetoes.
- A snapshot of a swinging platform's coverage picked a lane that
  made the bot die mid-switch across a bar's lane. Moving platforms
  are now handled by the lane-0 rule only (lane 0 is always covered).
- Wall-avoidance switches walked the bot off a moving platform's
  coverage. New rule: never walk off a moving platform — hold the
  lane while grounded, switch in the air; coyote jumps allowed.
- The bot never jumped for mid-platform jump-orbs. It now hops for
  a jump-orb in its lane when there is landing room.

**Visual fixes from the eye inspection (2026-11-22 ~12:25 +07)**

- First menu screenshot read as a flat panel over darkness (live 3D
  hidden behind the near-opaque panel/overlay). Fixed: overlay
  gradient 0.25/0.72 → 0.08/0.5, panel alpha 0.82 → 0.68, blur
  6px → 4px; scene brightened (hemi 0.85 → 1.15, dir 1.0 → 1.3,
  platform color 0x3b2a7a → 0x4a3590 + emissive up, city emissive
  0.5 → 0.85, fog 0.014 → 0.010). Menu now shows the void city and
  platforms around/through the panel.
- First gameplay screenshot showed the runner as a tiny dot half-cut
  at the bottom — that shot caught the runner mid-fall after the
  unguided-phase death, not a camera bug: a probe measured the
  runner at 54–68% down the screen while running. Camera was
  still moved closer/lower (y 4.6 → 3.6, z +9.5 → +7.5, lookAt
  y 1.0 → 1.4) so the runner reads bigger; screen-space deltas
  grew (lane 640 → 597 → 644, jump y 478 → 431). README gameplay
  capture now shows the runner clearly mid-frame with the
  checkpoint ring, wall barrier, gold orb and a fading PERFECT pop.
- Portrait (1080x2340): playable and readable; menu has no clipping
  (attract-demo runner reads large behind the panel, top half empty
  sky — landscape-first, acceptable for M1).

**Render-check fixes (same session)**

- First full run failed only on the `perfect` feedback bundle:
  `info().feedback` returned just the last 12 entries, so the
  perfect entries had scrolled out by the end of a track-1 run.
  Fixed: feedback log cap 40 → 160, `info()` returns the full log.
- The 2 deaths in the first browser autopilot run were NOT a sim
  bug: the unguided manual phase (lane/jump screen-space tests +
  screenshots) lets the runner sprint with no input, so it fell in
  the first gap twice before the autopilot engaged. A Node takeover
  from the same mid-run state (s=12, lane 1) completes with 0
  deaths. The render check now measures autopilot-only deaths
  (2nd run: 0 under autopilot).
- screenshots.js: sweep screenshots got a 120s timeout (the
  1080x2340 menu capture timed out at 30s under swiftshader);
  the 1080x2340 set was captured by a one-off script with the
  same flow.

**Final verification on the finished tree (2026-11-22 ~12:33 +07)**

- `node --check` physics.js + game.js: OK.
- Smoke: **PASS — 315/315, 0 failed**.
- Bot: **PASS** — decision bot clears all 6 tracks with 0 deaths
  (T1 18.6s/950, T2 18.8s/800, T3 19.2s/650, T4 18.3s/1550,
  T5 20.3s/550, T6 19.6s/1200); random bots fail all 6 on 5 lives
  (2 seeds each); no-input dies on all 6.
- Render check: **PASS** (re-run after the visual fixes) — zero
  console errors; screen-space lane left/right + jump asserted;
  autopilot clears track 1 (28.4s, 950, 9/9 orbs, 3 perfects,
  max chain x3, 0 deaths under autopilot); jump/perfect/orb/land
  feedback bundles complete (5+ layers); best time saved; track 2
  unlocks; void death + checkpoint reset; death bundle complete;
  P pause / Enter resume / R restart; rest state clean
  (trauma 0, fov 62, timeScale 1); shake 0 suppresses shake;
  settings (Large text + high contrast) persist across reload;
  touch tap jumps (screen y 493 → 436).
- Size sweep: **PASS by eye** — menu/settings/gameplay at
  1280x720, 2560x1080, 1080x2340 (9 shots in
  /tmp/neon-apex-size-sweep/), no clipping or overlap.
  README captures in docs/screenshots/ (menu.png, gameplay.png,
  complete.png) inspected by eye.

**Still unverified (for the 13:30 milestone run)**

- Real-browser FUN playtest in a live browser — not done in this
  run (no browser tools in this worker role). The headless render
  check + size sweep are done; the FUN verdict belongs to the
  13:30 run before any push.
- Repo creation on github.com + first browser-upload push + live
  site verification (13:30 run).
