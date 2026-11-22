// Neon Apex v0.4.0 — headless eye-playtest of ALL 12 tracks (M2 gate,
// M4: TA=1 re-runs the whole sweep in Time Attack mode).
// Serves the local game dir, seeds a save with tracks 1-11 cleared (so all
// 12 unlock — the same unlock rule the live game uses), then drives every
// track with the in-game autopilot (the decision bot through the public
// __apex hooks: real timing decisions, no random flailing) and captures
// screenshots at 35% and 70% of each track for inspection BY EYE:
//   - each track reads as its own identity (gap rhythm, barrier mix,
//     platform movement, visual accent)
//   - magenta walls and orange over-bars are visually distinct and
//     readable before the runner reaches them
//   - no wall sits in a lane the player must cross to set up the next jump
//   - orb lines pull the runner forward along risky lines
//   - T1's two over-bars (platforms 8 and 11) are visible and readable
//   - T9's slide chains read as slide chains, not walls
//   - in TA mode: the countdown HUD reads, +s pops fire on orbs, the
//     clock left at the finish is the margin (tight on T6/T9, wide on
//     the orb-rich T1/T7 — the mode's difficulty tracks orb density)
// Records per-track clear time / score / orbs / perfects / deaths and
// asserts the same gates as tests/bot.js, in the real renderer.
// Run: node tests/playtest-tracks.js        (normal mode)
//      TA=1 node tests/playtest-tracks.js   (Time Attack mode)
// Output: screenshots + playtest-tracks.json in the shots dir printed below.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TA_MODE = process.env.TA === '1';
const SHOTS_DIR = path.join(os.homedir(), 'workspace', 'goals', 'neon-apex-sprint', 'hidden_files', TA_MODE ? 'm4-playtest-shots' : 'm2-playtest-shots');
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

const errors = [];
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const results = [];
let browser;
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(stamp() + ' console: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));

  if (!process.env.NO_THREE_CACHE) {
    const cached = await fetchThreeModule();
    await page.route(THREE_URL, (route) => route.fulfill({ path: cached }));
  }

  // Seed a save with tracks 1-11 cleared, so all 12 unlock through the
  // game's own unlock rule (isTrackUnlocked: best[id-1] exists). This is
  // the harness's save file, not a change to the shipped game.
  await page.addInitScript(() => {
    const best = {};
    for (let id = 1; id <= 11; id++) best[id] = { time: 30 + id, score: 1000, orbs: 5, deaths: 0 };
    localStorage.setItem('neon-apex-save-v1', JSON.stringify({
      version: 1, best,
      settings: { volume: 0.6, shake: 1, music: true, sfx: true, reduceFlashing: false, textSize: 1, highContrast: false, muted: false },
    }));
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__apex, null, { timeout: 30000 });
  const version = await page.evaluate(() => window.__apex.version);
  if (version !== '0.4.0') throw new Error(`expected version 0.4.0, got ${version}`);
  const unlocks = await page.evaluate(() => window.__apex.unlocks());
  if (!Object.values(unlocks).every(Boolean)) throw new Error(`seeded save should unlock all 12 tracks: ${JSON.stringify(unlocks)}`);
  console.log(`playtest-tracks: game 0.4.0 up, seeded save unlocks all 12 tracks, mode ${TA_MODE ? 'Time Attack' : 'normal'}`);

  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const tracks = await page.evaluate(() => window.__apex.tracks());
  for (const t of tracks) {
    const tag = `T${String(t.id).padStart(2, '0')}`;
    console.log(`playtest-tracks: --- ${tag} "${t.name}" (par ${t.par}s, ${t.orbCount} orbs, ${t.platforms} platforms, ${t.barriers} barriers) ---`);
    await page.evaluate(([id, mode]) => window.__apex.startTrack(id, mode), [t.id, TA_MODE ? 'ta' : 'normal']);
    // First track build compiles the full scene under swiftshader;
    // that can stall rAF for many seconds on a cold start, so this
    // wait is generous (M3: the 10s bound flaked once on T01).
    await page.waitForFunction(() => window.__apex.state.phase === 'run', null, { timeout: 60000 });
    await page.evaluate(() => window.__apex.autopilot(true));
    // Screenshot at 35% and 70% of the track length, while the decision
    // bot is playing — the eye check happens on these frames.
    for (const frac of [0.35, 0.7]) {
      const target = t.length * frac;
      try {
        await page.waitForFunction((s) => {
          const i = window.__apex.info();
          return i && (i.s >= s || i.completed);
        }, target, { timeout: 300000 });
      } catch {
        console.log(`playtest-tracks: ${tag} did not reach s=${target.toFixed(0)} before timeout — screenshotting where it is`);
      }
      const atShot = await page.evaluate(() => window.__apex.info());
      await page.waitForTimeout(150); // let the frame settle
      const shotPath = path.join(SHOTS_DIR, `${tag}-${Math.round(frac * 100)}pct.png`);
      await page.screenshot({ path: shotPath });
      console.log(`playtest-tracks: ${tag} shot ${Math.round(frac * 100)}% at s=${atShot ? atShot.s.toFixed(1) : '?'}/${t.length.toFixed(0)} -> ${shotPath}`);
    }
    await page.waitForFunction(() => {
      const i = window.__apex.info();
      return i && (i.completed || i.timeUp);
    }, null, { timeout: 420000 });
    const done = await page.evaluate(() => window.__apex.info());
    if (done.timeUp) throw new Error(`${tag}: autopilot ran out of clock in Time Attack (timeUp at ${done.time.toFixed(1)}s, ${done.orbs}/${t.orbCount} orbs)`);
    console.log(`playtest-tracks: ${tag} CLEARED in ${done.time.toFixed(1)}s (par ${t.par}s), score ${done.score}, orbs ${done.orbs}/${t.orbCount}, perfects ${done.perfects}, max chain x${done.maxChain}, deaths ${done.deaths}${TA_MODE ? `, clock left ${done.clock.toFixed(1)}s` : ''}`);
    results.push({
      id: t.id, name: t.name, par: t.par, orbCount: t.orbCount,
      time: +done.time.toFixed(1), score: done.score, orbs: done.orbs,
      perfects: done.perfects, maxChain: done.maxChain, deaths: done.deaths,
      clockLeft: TA_MODE ? +done.clock.toFixed(1) : null,
    });
    if (done.deaths > 2) throw new Error(`${tag}: autopilot died ${done.deaths} times (want <= 2)`);
    if (done.orbs < 1) throw new Error(`${tag}: autopilot collected no orbs`);
    if (done.perfects < 2) throw new Error(`${tag}: autopilot landed only ${done.perfects} perfects (want 2+)`);
    await page.evaluate(() => window.__apex.autopilot(false));
    await page.waitForFunction(() => window.__apex.state.phase === 'complete', null, { timeout: 10000 });
    await page.evaluate(() => window.__apex.quitToMenu());
    await page.waitForFunction(() => window.__apex.state.phase === 'menu', null, { timeout: 10000 });
  }

  if (errors.length) {
    console.error('playtest-tracks: console/page errors:');
    for (const e of errors) console.error('  ' + e);
    throw new Error(`${errors.length} console/page error(s)`);
  }
  fs.writeFileSync(path.join(SHOTS_DIR, 'playtest-tracks.json'), JSON.stringify({ version: '0.4.0', mode: TA_MODE ? 'ta' : 'normal', ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`playtest-tracks: PASS — decision-bot autopilot cleared all 12 tracks in the real renderer (${TA_MODE ? 'Time Attack' : 'normal'}), zero console errors`);
  console.log(`playtest-tracks: screenshots in ${SHOTS_DIR} — INSPECT BY EYE before calling M${TA_MODE ? '4' : '2'} done`);
} finally {
  if (browser) await browser.close();
  server.close();
}
