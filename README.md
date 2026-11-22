# Neon Apex — 3D Neon Sky-Parkour Runner

Sprint across floating neon platforms high above a void city. Time your
jumps, slide under barriers, switch lanes — land dead-centre to chain
speed. One deep core mechanic (jump timing), a real progression loop
(best times, track unlocks), consistent neon art direction, and game
feel on every event.

**Live:** https://namdev-muse.github.io/neon-apex/
**Version:** 0.4.0 (M4 progression & depth — Time Attack, medals, orb economy)
**Stack:** Three.js 0.160.0 (ES modules, import map, pinned CDN), vanilla
HTML/CSS/JS, Web Audio API synth SFX + step-sequencer music, no build
step, static files on GitHub Pages.

## How to play

- You auto-sprint forward. There is no brake — every gap is a decision.
- **Space / W / Up** — jump (press again in the air for a double jump).
- **S / Down** — slide under the orange overhead bars. You cannot jump over them.
- **A / D or Left / Right** — switch lanes to dodge the tall magenta walls.
- Land **dead-centre** on a platform to chain a **speed multiplier**.
- Collect **gold orbs** (the high ones only count mid-jump). Touch a
  **checkpoint ring** and a fall sends you back there.
- Fall into the void or hit a barrier → reset to the last checkpoint.
- Reach the **gold finish gate** to clear the track. Best time is saved
  per track; clearing a track unlocks the next one. Beat par for a
  **gold medal**, within 5 seconds for silver.
- **Time Attack** (pick it on the menu): the clock starts short — every
  **orb adds seconds** (ground orbs +1.5s, jump orbs +2.5s), every
  checkpoint +2s, every death −3s. Finish before it hits zero; the
  seconds left are banked into your score.
- **P** pause · **M** mute · **R** restart. Touch: tap to jump, swipe
  down to slide, swipe left/right to switch lanes.

## Orb economy

Orbs are the game's currency of time and the lifetime progression
number. Ground orbs are worth 50 points; the high jump orbs hang over
gaps and cost a jump to reach, so they pay **100 points** — and in Time
Attack they buy **2.5s of clock** against 1.5s for a ground orb. Every
orb from a cleared track is banked for good (shown on the menu); a run
that ends in a fall banks nothing. A Time Attack run that ignores orbs
runs dry before the finish on the orb-sparse tracks — the clock is
fuelled by orbs, not by the starting budget.

## Tracks

| # | Track | Identity |
|---|-------|----------|
| 1 | First Steps | Teaches: small gaps, one wall, one bar, slow speed |
| 2 | Neon Steps | Varied gap rhythm, wall pairs |
| 3 | Magenta Maze | Wall-heavy — lane switching is the test |
| 4 | Skyline Sprint | Moving platforms + the first double-jump gap |
| 5 | Void Waltz | Everything mixed at higher speed |
| 6 | Apex Run | Tightest, fastest, everything at once |
| 7 | Golden Mile | Orb-heavy — gold lines in risky lanes |
| 8 | Slalom City | Wall slalom — the open lane never stays put |
| 9 | Low Ceiling | Over-bar heavy — slide chains, double bars |
| 10 | Drift Fields | Moving-platform heavy, wide 1.4 sway |
| 11 | Double Trouble | Long gaps (7–10.5u) — double jump is the only way across |
| 12 | Apex Prime | Everything at full speed, three checkpoints |

## Anti-slop

No auto-jump, no assist, no "jump now" prompt, no landing preview —
jump timing is the skill. A bot that jumps/slides/switches lanes at
random cannot finish any track on 5 lives; a bot that plays with real
timing decisions clears all 12 with no deaths. Lane/jump behaviour is
asserted in **screen space** (the lane the player sees matches the
physics).

## Tests

```sh
node tests/smoke.js        # 592 physics checks (no DOM)
node tests/bot.js          # decision bot clears all 12; random bots fail all 12 on 5 lives; Time Attack gate (bot clears 12/12, orb-blind runs dry on 5/12)
node tests/render-check.js # headless Chromium: menu, screen-space movement, autopilot clears track 1, Time Attack clear + time-up path
node tests/screenshots.js # README captures + 3-resolution size sweep
```

## Devlog

See [docs/devlog.md](docs/devlog.md).
