# Neon Apex — 3D Neon Sky-Parkour Runner

Sprint across floating neon platforms high above a void city. Time your
jumps, slide under barriers, switch lanes — land dead-centre to chain
speed. One deep core mechanic (jump timing), a real progression loop
(best times, track unlocks), consistent neon art direction, and game
feel on every event.

**Live:** https://namdev-muse.github.io/neon-apex/
**Version:** 0.3.0 (M3 feel & juice)
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
  per track; clearing a track unlocks the next one.
- **P** pause · **M** mute · **R** restart. Touch: tap to jump, swipe
  down to slide, swipe left/right to switch lanes.

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
node tests/smoke.js        # 564 physics checks (no DOM)
node tests/bot.js          # decision bot clears all 12; random bots fail all 12 on 5 lives
node tests/render-check.js # headless Chromium: menu, screen-space movement, autopilot clears track 1
node tests/screenshots.js # README captures + 3-resolution size sweep
```

## Devlog

See [docs/devlog.md](docs/devlog.md).
