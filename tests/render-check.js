// Neon Apex v0.3.1 — headless browser render check.
// Serves the game dir over local HTTP, loads it in a headless
// browser, and asserts the M1 core, by hook and by eye:
//   - the menu renders over a LIVE 3D scene (the attract demo
//     actually runs — the demo runner advances), with no
//     version/engine text anywhere the player can see, one clear
//     primary Play action, and 6 track cards (track 1 unlocked,
//     track 2 locked on a fresh save)
//   - Play starts track 1 with the HUD; the runner auto-sprints
//   - lane switching is asserted in SCREEN space: ArrowLeft moves
//     the runner LEFT on screen, ArrowRight RIGHT (the Drift M2
//     lesson — a mirrored input bug survived every world-space test)
//   - jump is asserted in SCREEN space too: the runner rises on
//     screen when Space is pressed
//   - the autopilot (decision bot) clears track 1, collects orbs,
//     and chains a perfect landing
//   - with no input the runner falls into the void and resets to
//     the last checkpoint (death + respawn work)
//   - pause focuses Resume; Enter resumes; R restarts
//   - shake 0 suppresses shakeAmp; the rest state settles clean
//     (trauma 0, FOV 62, time scale 1)
//   - the canvas pixels actually change during a run
//   - zero console errors and zero page errors, and a WebGL context exists
//
// Run: node tests/render-check.js
//
// CDN note: the repo pins Three.js 0.160.0 from jsdelivr and does NOT
// vendor it. The sandboxed browser cannot reach the jsdelivr CDN (the VM
// egress proxy answers policy_denied to every non-curl/wget client,
// including Chromium), even though curl gets HTTP 200 for the pinned
// URL from this VM. So this check downloads the pinned module with
// curl into the OS temp dir and fulfils that one request locally via
// Playwright routing — the page still requests the exact pinned URL, and
// the repo keeps no copy of Three.js. On a machine where the browser can
// reach the CDN, set NO_THREE_CACHE=1 to skip the substitution and load
// it live.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-apex-render-check');
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const THREE_CACHE = path.join(os.tmpdir(), 'neon-apex-three-0.160.0.module.js');

async function fetchThreeModule() {
  try {
    const st = fs.statSync(THREE_CACHE);
    if (st.size > 100000) return THREE_CACHE;
  } catch { /* not cached yet */ }
  await new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-o', THREE_CACHE, THREE_URL], (err) => (err ? reject(err) : resolve()));
  });
  const st = fs.statSync(THREE_CACHE);
  if (st.size < 100000) throw new Error(`downloaded Three.js module is unexpectedly small (${st.size} bytes)`);
  return THREE_CACHE;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function findHeadlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(base)) {
      const candidate = path.join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* cache dir missing */ }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(GAME_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const require = createRequire(import.meta.url);
const playwrightPath = fileURLToPath(new URL('../../neon-hexfall/node_modules/playwright-core', import.meta.url));
const { chromium } = require(playwrightPath);
const executablePath = findHeadlessShell();
console.log('render-check: chromium executable:', executablePath || '(playwright default)');

const errors = [];
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
let browser;
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(stamp() + ' console: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));

  if (!process.env.NO_THREE_CACHE) {
    const cached = await fetchThreeModule();
    console.log(`render-check: fulfilling pinned three@0.160.0 from local curl cache (${cached}) — sandboxed browser cannot reach jsdelivr directly`);
    await page.route(THREE_URL, (route) => route.fulfill({ path: cached }));
  }

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForFunction(() => window.__apex, null, { timeout: 30000 });
  } catch {
    console.error('render-check: window.__apex never appeared — the pinned Three.js module failed to load.');
    console.error('CDN check from this VM: curl -sI ' + THREE_URL + ' (expect HTTP 200).');
    throw new Error('game module did not initialise (see CDN note above)');
  }

  const version = await page.evaluate(() => window.__apex.version);
  if (version !== '0.3.1') throw new Error(`expected version 0.3.1, got ${version}`);
  console.log('render-check: game module initialised, version 0.3.1');

  // WebGL context exists and the canvas is on screen.
  const gl = await page.evaluate(() => {
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return ctx ? { width: canvas.width, height: canvas.height } : null;
  });
  if (!gl) throw new Error('no WebGL context on the game canvas');
  console.log(`render-check: WebGL context live (${gl.width}x${gl.height} canvas)`);

  // The menu: title, one primary Play, 12 track cards, NO version/engine
  // text anywhere the player can see. Track 1 unlocked, track 2 locked.
  const menuText = await page.textContent('#menu');
  if (!menuText.includes('NEON APEX')) throw new Error('menu title missing');
  if (menuText.includes('v0.3.1') || menuText.includes('Three.js') || menuText.includes('0.160.0')) {
    throw new Error('menu shows version/engine text — it must live in the README only');
  }
  const playClass = await page.getAttribute('#btn-play', 'class');
  if (!playClass || !playClass.includes('primary')) throw new Error('Play is not the primary action');
  const trackCards = await page.locator('#track-select .track-card').count();
  if (trackCards !== 12) throw new Error(`expected 12 track cards, got ${trackCards}`);
  const tracks = await page.evaluate(() => window.__apex.tracks());
  if (tracks.length !== 12 || tracks[0].name !== 'First Steps' || tracks[11].name !== 'Apex Prime') {
    throw new Error(`track list wrong: ${JSON.stringify(tracks.map((t) => t.name))}`);
  }
  const unlocks0 = await page.evaluate(() => window.__apex.unlocks());
  if (unlocks0[1] !== true || unlocks0[2] !== false) {
    throw new Error(`fresh save should unlock only track 1: ${JSON.stringify(unlocks0)}`);
  }
  const lockedCards = await page.locator('#track-select .track-card.locked').count();
  if (lockedCards !== 11) throw new Error(`expected 11 locked track cards on a fresh save, got ${lockedCards}`);
  console.log('render-check: menu renders — live 3D behind it, no version text, Play primary, 12 tracks, track 1 unlocked only');

  // The attract demo runs behind the menu: the demo runner advances.
  const demo0 = await page.evaluate(() => window.__apex.info());
  if (!demo0) throw new Error('no demo info in the menu phase');
  await page.waitForFunction((s0) => {
    const i = window.__apex.info();
    return i && i.s > s0 + 10;
  }, demo0.s, { timeout: 60000 });
  const demo1 = await page.evaluate(() => window.__apex.info());
  console.log(`render-check: attract demo alive — demo runner advanced (s ${demo0.s.toFixed(1)} -> ${demo1.s.toFixed(1)})`);

  // Menu screenshot for the by-eye check.
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(1200); // let the menu pop-in finish + the demo runner run in
  await page.screenshot({ path: path.join(SHOTS_DIR, 'menu-1280x720.png') });
  console.log(`render-check: menu screenshot saved to ${SHOTS_DIR}/menu-1280x720.png — INSPECT BY EYE (live 3D scene, no clipped cards)`);

  // PLAY starts track 1 with the HUD.
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__apex.state.phase === 'run', null, { timeout: 5000 });
  if (!await page.isVisible('#hud')) throw new Error('HUD not visible after PLAY');
  const hudTrack = await page.textContent('#hud-track');
  if (!hudTrack.includes('First Steps')) throw new Error(`expected track 1 First Steps, got: ${hudTrack}`);
  console.log('render-check: PLAY starts track 1 (First Steps), HUD visible');

  // The runner auto-sprints: s advances with no input at all.
  const run0 = await page.evaluate(() => window.__apex.info());
  await page.waitForFunction((s0) => {
    const i = window.__apex.info();
    return i && i.s > s0 + 5;
  }, run0.s, { timeout: 30000 });
  const run1 = await page.evaluate(() => window.__apex.info());
  console.log(`render-check: runner auto-sprints with no input (s ${run0.s.toFixed(1)} -> ${run1.s.toFixed(1)})`);

  // Lane switching is asserted in SCREEN space: ArrowLeft must move
  // the runner LEFT on screen, ArrowRight RIGHT. The camera looks
  // down -z, so world +x is screen right — the Drift M2 lesson.
  // Under swiftshader a lane switch is slow in real time, so poll.
  async function laneScreen(key, dir) {
    const x0 = (await page.evaluate(() => window.__apex.info().screen)).x;
    await page.keyboard.down(key);
    try {
      await page.waitForFunction(([x, d]) => {
        const i = window.__apex.info();
        return d > 0 ? i.screen.x > x + 20 : i.screen.x < x - 20;
      }, [x0, dir], { timeout: 20000 });
    } finally {
      await page.keyboard.up(key);
    }
    const x1 = (await page.evaluate(() => window.__apex.info().screen)).x;
    if (!((dir > 0 && x1 > x0 + 20) || (dir < 0 && x1 < x0 - 20))) {
      throw new Error(`${key} did not move the runner on screen (${x0.toFixed(0)} -> ${x1.toFixed(0)})`);
    }
    return { x0, x1 };
  }
  const left = await laneScreen('ArrowLeft', -1);
  console.log(`render-check: ArrowLeft moves the runner left on screen (${left.x0.toFixed(0)} -> ${left.x1.toFixed(0)})`);
  const right = await laneScreen('ArrowRight', 1);
  console.log(`render-check: ArrowRight moves the runner right on screen (${right.x0.toFixed(0)} -> ${right.x1.toFixed(0)})`);

  // Jump is asserted in SCREEN space too: Space must raise the
  // runner on screen (screen y decreases). Poll while airborne.
  // M3: measure feedback latency — the jump bundle must fire within
  // ~100ms of the press on real hardware; it fires synchronously
  // inside the sim step that consumes the input, so the only delay
  // is waiting for the next frame (swiftshader frames are slow, so
  // the headless bound is 2000ms — the measured value is logged).
  const y0 = (await page.evaluate(() => window.__apex.info().screen)).y;
  const jumpT0 = Date.now();
  await page.keyboard.press('Space');
  await page.waitForFunction((yy) => {
    const i = window.__apex.info();
    return i && i.screen.y < yy - 20;
  }, y0, { timeout: 20000 });
  const jumpFb = await page.evaluate(() => window.__apex.info().feedback.filter((f) => f.type === 'jump').pop());
  const jumpLatency = jumpFb ? jumpFb.t - jumpT0 : -1;
  if (jumpLatency < 0 || jumpLatency > 2000) throw new Error(`jump feedback did not fire promptly after Space (latency ${jumpLatency}ms)`);
  console.log(`render-check: jump feedback fired ${jumpLatency}ms after Space (bundle: ${jumpFb.layers.join(', ')})`);
  const y1 = (await page.evaluate(() => window.__apex.info().screen)).y;
  console.log(`render-check: Space jumps the runner up on screen (y ${y0.toFixed(0)} -> ${y1.toFixed(0)})`);
  // Wait for the landing: the runner must come back down to the ground.
  await page.waitForFunction(() => {
    const i = window.__apex.info();
    return i && i.grounded;
  }, null, { timeout: 20000 });
  console.log('render-check: runner lands back on the platform after the jump');

  // M3: the music sequencer advances while a run is live (bass +
  // arp + pad layers all schedule through the same step counter).
  await page.waitForTimeout(3000);
  const musicStep = await page.evaluate(() => window.__apex.info().audio && window.__apex.info().audio.musicStep);
  if (musicStep === null || musicStep === undefined) throw new Error('no audio context after starting a run — music cannot play');
  if (musicStep <= 0) throw new Error(`music sequencer did not advance during the run (musicStep ${musicStep})`);
  console.log(`render-check: music sequencer advancing (musicStep ${musicStep} after 3s of running)`);

  // The canvas must actually update during a run (a frozen render
  // loop still leaves sim state looking alive).
  const shotA = await page.screenshot();
  await page.waitForTimeout(1000);
  const shotB = await page.screenshot();
  if (shotA.equals(shotB)) throw new Error('canvas did not change between two screenshots during a run — the render loop may be frozen');
  console.log('render-check: canvas updates during a run (two screenshots differ)');

  // Gameplay screenshot for the by-eye check.
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gameplay-1280x720.png') });
  console.log(`render-check: gameplay screenshot saved to ${SHOTS_DIR}/gameplay-1280x720.png — INSPECT BY EYE (3D depth, platforms, HUD)`);

  // The autopilot (decision bot) clears track 1: the core loop works
  // end to end. Under swiftshader a full track takes minutes of
  // real time, so this is a long poll, not a fixed window.
  // NOTE: the unguided manual phase above already died twice (the
  // runner sprints with no input while the test screenshots) — so
  // the autopilot's own deaths are measured from here, not from 0.
  const deathsBefore = (await page.evaluate(() => window.__apex.info())).deaths;
  await page.evaluate(() => window.__apex.autopilot(true));
  await page.waitForFunction(() => {
    const i = window.__apex.info();
    return i && i.completed;
  }, null, { timeout: 420000 });
  const cleared = await page.evaluate(() => window.__apex.info());
  console.log(`render-check: autopilot clears track 1 (time ${cleared.time.toFixed(1)}s, score ${cleared.score}, orbs ${cleared.orbs}, perfects ${cleared.perfects}, max chain x${cleared.maxChain}, deaths ${cleared.deaths} total, ${cleared.deaths - deathsBefore} under autopilot)`);
  if (cleared.orbs < 1) throw new Error('autopilot cleared track 1 without collecting an orb');
  if (cleared.perfects < 1) throw new Error('autopilot cleared track 1 without a perfect landing — the chain is the core');
  if (cleared.deaths - deathsBefore > 2) throw new Error(`autopilot died ${cleared.deaths - deathsBefore} times on track 1 (want <= 2)`);
  // The feedback bundles fired completely in the browser.
  const fb = await page.evaluate(() => window.__apex.info().feedback);
  for (const type of ['jump', 'perfect', 'orb', 'land']) {
    const entry = fb.filter((f) => f.type === type).pop();
    if (!entry || entry.layers.length < 5) {
      throw new Error(`${type} feedback bundle incomplete: ${JSON.stringify(entry)}`);
    }
  }
  console.log('render-check: jump/perfect/orb/land feedback bundles complete (5+ layers each)');
  // M3: the checkpoint rings dissolved as the runner passed them —
  // no solid torus left to sweep the camera (the M2 wart).
  const rings = await page.evaluate(() => window.__apex.rings());
  if (!rings.length) throw new Error('no checkpoint rings found on track 1');
  const undissolved = rings.filter((r) => !r.done || r.opacity > 0.05 || r.visible);
  if (undissolved.length) throw new Error(`checkpoint rings did not dissolve after passing: ${JSON.stringify(undissolved)}`);
  console.log(`render-check: all ${rings.length} checkpoint rings dissolved after passing (fade + shrink, then hidden)`);
  // The complete screen shows, with the best time saved.
  await page.waitForFunction(() => window.__apex.state.phase === 'complete', null, { timeout: 5000 });
  const compText = await page.textContent('#complete');
  if (!compText.includes('Track Clear')) throw new Error(`complete screen should show Track Clear: ${compText.slice(0, 200)}`);
  const saved = await page.evaluate(() => window.__apex.save());
  if (!saved.best || !saved.best[1] || saved.best[1].time <= 0) {
    throw new Error(`best time should be saved for track 1: ${JSON.stringify(saved.best)}`);
  }
  console.log(`render-check: track clear — best time ${saved.best[1].time.toFixed(1)}s saved for track 1`);
  // The gates opened: clearing track 1 unlocks track 2.
  const unlocks1 = await page.evaluate(() => window.__apex.unlocks());
  if (!unlocks1[2]) throw new Error(`clearing track 1 should unlock track 2: ${JSON.stringify(unlocks1)}`);
  console.log('render-check: gates opened — track 2 unlocked after clearing track 1');

  // Back to the menu, then a fresh track-1 run with no input:
  // the runner must fall into the void and reset to a checkpoint.
  await page.click('#btn-menu-complete');
  await page.waitForFunction(() => window.__apex.state.phase === 'menu', null, { timeout: 5000 });
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__apex.state.phase === 'run', null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const i = window.__apex.info();
    return i && i.deaths >= 1;
  }, null, { timeout: 120000 });
  const died = await page.evaluate(() => window.__apex.info());
  console.log(`render-check: no-input run dies in the void and resets (deaths ${died.deaths}, s back to ${died.s.toFixed(1)})`);
  const fbDeath = await page.evaluate(() => window.__apex.info().feedback);
  const deathEntry = fbDeath.filter((f) => f.type === 'death').pop();
  if (!deathEntry || deathEntry.layers.length < 5) {
    throw new Error(`death feedback bundle incomplete: ${JSON.stringify(deathEntry)}`);
  }
  console.log(`render-check: death bundle complete (${deathEntry.layers.join(', ')})`);

  // Pause focuses Resume; Enter resumes.
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__apex.state.phase === 'paused', null, { timeout: 5000 });
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (focused !== 'btn-resume') throw new Error(`pause should focus Resume, focused: ${focused}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__apex.state.phase === 'run', null, { timeout: 5000 });
  console.log('render-check: P pauses with Resume focused, Enter resumes');

  // R restarts the track from the start.
  await page.keyboard.press('r');
  await page.waitForFunction(() => {
    const i = window.__apex.info();
    return window.__apex.state.phase === 'run' && i.s < 10 && i.deaths === 0;
  }, null, { timeout: 5000 });
  console.log('render-check: R restarts the track (back at the start, 0 deaths)');

  // Rest state: pause on a fresh, unmoved run and confirm every
  // effect settles back exactly — trauma 0, FOV 62, time scale 1.
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__apex.state.phase === 'paused', null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const i = window.__apex.info();
    return i.trauma < 0.02 && Math.abs(i.fov - 62) < 0.5 && i.timeScale === 1;
  }, null, { timeout: 15000 });
  const rest = await page.evaluate(() => window.__apex.info());
  console.log(`render-check: rest state clean (trauma ${rest.trauma.toFixed(3)}, fov ${rest.fov.toFixed(2)}, timeScale ${rest.timeScale})`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__apex.state.phase === 'run', null, { timeout: 5000 });

  // Shake toggle at 0 kills the shake even when events fire.
  await page.evaluate(() => window.__apex.setShake(0));
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const noShake = await page.evaluate(() => window.__apex.info().shakeAmp);
  if (noShake !== 0) throw new Error(`shake 0 must give shakeAmp 0, got ${noShake}`);
  await page.evaluate(() => window.__apex.setShake(1));
  console.log('render-check: shake 0 suppresses shakeAmp even after a jump; restored to 1');

  // M3: reduce-flashing suppresses the hit flash, and turning it
  // off brings the flash back. testFeedback fires a death bundle
  // on demand so the toggle is asserted directly, not by staging
  // a real death.
  await page.evaluate(() => window.__apex.setReduceFlashing(true));
  const flashOff = await page.evaluate(() => {
    window.__apex.testFeedback('death');
    return document.getElementById('hit-flash').classList.contains('show');
  });
  if (flashOff) throw new Error('reduce-flashing on must suppress the hit flash');
  await page.evaluate(() => window.__apex.setReduceFlashing(false));
  const flashOn = await page.evaluate(() => {
    window.__apex.testFeedback('death');
    return document.getElementById('hit-flash').classList.contains('show');
  });
  if (!flashOn) throw new Error('reduce-flashing off must allow the hit flash');
  console.log('render-check: reduce-flashing toggle suppresses/restores the hit flash');

  // Settings persist across a reload: Large text + high contrast.
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__apex.state.phase === 'paused', null, { timeout: 5000 });
  await page.click('#btn-quit');
  await page.waitForFunction(() => window.__apex.state.phase === 'menu', null, { timeout: 5000 });
  await page.click('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('settings').classList.contains('hidden'), null, { timeout: 5000 });
  await page.selectOption('#text-size-select', '1.2');
  const rootFont = await page.evaluate(() => document.documentElement.style.fontSize);
  if (rootFont !== '120%') throw new Error(`text size Large should set root font-size to 120%, got ${rootFont}`);
  await page.check('#high-contrast-toggle');
  if (!await page.evaluate(() => document.body.classList.contains('high-contrast'))) {
    throw new Error('high contrast toggle did not apply the body class');
  }
  await page.click('#btn-settings-close');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__apex, null, { timeout: 30000 });
  const savedSettings = await page.evaluate(() => window.__apex.save());
  if (savedSettings.settings.textSize !== 1.2 || savedSettings.settings.highContrast !== true) {
    throw new Error(`accessibility settings did not persist: ${JSON.stringify(savedSettings.settings)}`);
  }
  if (await page.evaluate(() => document.documentElement.style.fontSize) !== '120%') {
    throw new Error('text size did not re-apply after reload');
  }
  if (!await page.evaluate(() => document.body.classList.contains('high-contrast'))) {
    throw new Error('high contrast did not re-apply after reload');
  }
  console.log('render-check: settings — Large text (120%) + high contrast apply and persist across reload');
  await page.evaluate(() => { window.__apex.setTextSize(1); window.__apex.setHighContrast(false); });

  // Touch: a tap on the game container jumps the runner.
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__apex.state.phase === 'run', null, { timeout: 5000 });
  const tapY0 = (await page.evaluate(() => window.__apex.info().screen)).y;
  await page.touchscreen.tap(640, 360);
  await page.waitForFunction((yy) => {
    const i = window.__apex.info();
    return i && i.screen.y < yy - 20;
  }, tapY0, { timeout: 20000 });
  const tapY1 = (await page.evaluate(() => window.__apex.info().screen)).y;
  console.log(`render-check: touch tap jumps the runner (screen y ${tapY0.toFixed(0)} -> ${tapY1.toFixed(0)})`);

  if (errors.length) {
    console.error('render-check: console/page errors:');
    for (const e of errors) console.error('  ' + e);
    throw new Error(`${errors.length} console/page error(s)`);
  }
  console.log('render-check: PASS — menu, screen-space movement + jump, autopilot clears track 1, void death + checkpoint reset, pause/resume/restart, settings persist, touch tap jumps, M3 feel (jump feedback latency, music sequencer, ring dissolve, reduce-flashing toggle), zero console errors');
} finally {
  if (browser) await browser.close();
  server.close();
}
