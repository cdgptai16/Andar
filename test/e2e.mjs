// End-to-end test in headless Chromium: real app file, mocked GPS, motion sensor and map services.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const E = require('../src/engine.js');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'dist/index.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}

const { osrm, timeline } = E.demoDrive();
const origin = timeline[0].fix;
const dest = timeline[timeline.length - 1].fix;

async function newPage({ clock = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    permissions: ['geolocation'],
    geolocation: { latitude: origin.lat, longitude: origin.lon, accuracy: 5 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/nominatim.openstreetmap.org/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([{ lat: String(dest.lat), lon: String(dest.lon), display_name: 'Test Destination, Plano, Texas' }]),
    })
  );
  await page.route('**/router.project-osrm.org/**', (route) =>
    route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(osrm) })
  );
  if (clock) await page.clock.install();
  await page.goto(url);
  // Record every turn label the app shows.
  await page.evaluate(() => {
    window.__labels = [];
    window.__levels = [];
    new MutationObserver(() => {
      const t = document.querySelector('#turn-label').textContent;
      if (t) {
        window.__labels.push(t);
        window.__levels.push(`${document.querySelector('#turn-cue').dataset.level}:${t}`);
      }
    }).observe(document.querySelector('#turn-label'), { childList: true, characterData: true, subtree: true });
  });
  return { context, page, errors };
}

async function ackSafety(page) {
  await page.click('#go-setup');
  await page.click('#ack-safety');
  await page.waitForSelector('#setup:not([hidden])');
}

async function startMotionFeed(page) {
  // Upright phone: gravity on +y, tiny noise so calibration sees real samples.
  await page.evaluate(() => {
    let k = 0;
    window.__motion = setInterval(() => {
      k += 1;
      window.dispatchEvent(
        new DeviceMotionEvent('devicemotion', {
          accelerationIncludingGravity: { x: 0.02 * Math.sin(k), y: 9.81, z: window.__accZ || 0.03 },
        })
      );
    }, 20);
  });
}

async function driveRoute(context, stepMs = 250) {
  for (const step of timeline) {
    await context.setGeolocation({ latitude: step.fix.lat, longitude: step.fix.lon, accuracy: 5 });
    await new Promise((r) => setTimeout(r, stepMs));
  }
  await new Promise((r) => setTimeout(r, 1500)); // let scheduled cues fire
}

async function planAndStart(page) {
  await page.waitForSelector('#gps-dot.ok', { timeout: 8000 });
  await page.fill('#dest', 'Test Destination');
  await page.click('#dest-search');
  await page.click('.result-btn');
  await page.waitForFunction(() => document.querySelector('#route-summary').textContent.includes('turns to cue'));
  assert.equal(await page.isDisabled('#start-ride'), false);
  await startMotionFeed(page);
  await page.click('#start-ride');
  await page.waitForSelector('#ride:not([hidden])', { timeout: 6000 });
  // Baseline check-in appears right away.
  await page.waitForSelector('#rate:not([hidden])');
  await page.click('#scale button[data-v="2"]');
}

async function endAndSave(page) {
  await page.click('#end-ride');
  await page.click('#end-ride');
  await page.waitForSelector('#end:not([hidden])');
  await page.check('input[name="seat"][value="front"]');
  await page.check('input[name="activity"][value="looking-out"]');
  await page.check('input[name="road"][value="city"]');
  await page.click('#end-form button[type="submit"]');
  await page.waitForSelector('#results:not([hidden])');
}

/* 1. Demo drive fires left, right and arrive cues, then returns home without saving. */
await check('demo drive cues every maneuver and saves nothing', async () => {
  const { page, errors } = await newPage({ clock: true });
  await ackSafety(page);
  await page.click('#setup [data-nav="home"]');
  await page.click('#go-demo');
  await page.waitForSelector('#ride:not([hidden])');
  for (let i = 0; i < 14; i++) await page.clock.runFor(5000);
  await page.waitForSelector('#home:not([hidden])');
  const labels = await page.evaluate(() => window.__labels);
  assert.ok(labels.some((l) => l.startsWith('Left')), `labels: ${labels}`);
  assert.ok(labels.some((l) => l.startsWith('Sharp right')), `labels: ${labels}`);
  assert.ok(labels.includes('Arriving'), `labels: ${labels}`);
  assert.match(await page.textContent('#toast'), /Demo finished: 3 turn cues fired/);
  assert.equal(await page.evaluate(() => window.__andar.store.rides.length), 0);
  assert.deepEqual(errors, []);
});

/* 2+3. A real "cues on" ride, then the scheduled "cues off" ride records but shows nothing. */
await check('cues-on ride shows turn cues, saves, and schedules a cues-off ride next', async () => {
  const { context, page, errors } = await newPage();
  await ackSafety(page);
  assert.match(await page.textContent('#start-condition'), /Cues on/);
  await planAndStart(page);
  assert.equal(await page.textContent('#ride-pill'), 'Cues on');
  await driveRoute(context);
  const labels = await page.evaluate(() => window.__labels);
  assert.ok(labels.some((l) => l === 'Left onto Sample St'), `labels: ${labels}`);
  assert.ok(labels.some((l) => l === 'Sharp right onto Test Rd'), `labels: ${labels}`);
  const levels = await page.evaluate(() => window.__levels);
  assert.ok(levels.includes('2:Left onto Sample St'), `levels: ${levels}`);
  assert.ok(levels.includes('3:Sharp right onto Test Rd'), `levels: ${levels}`);
  // Two chevrons visible for a normal left; three for a sharp right.
  const visibleChevrons = (dir, level) =>
    page.evaluate(([d, l]) => {
      const cue = document.querySelector('#turn-cue');
      cue.dataset.dir = d;
      cue.dataset.level = String(l);
      const group = document.querySelector(d === 'left' ? '.chev.l' : '.chev.r');
      return [...group.querySelectorAll('svg')].filter((x) => getComputedStyle(x).display !== 'none').length;
    }, [dir, level]);
  assert.equal(await visibleChevrons('left', 1), 1);
  assert.equal(await visibleChevrons('left', 2), 2);
  assert.equal(await visibleChevrons('right', 3), 3);
  // Vibration count matches chevron count; direction by pulse length.
  const pat = await page.evaluate(() => [
    window.__andar.hapticPattern('left', 1),
    window.__andar.hapticPattern('left', 2),
    window.__andar.hapticPattern('right', 3),
  ]);
  assert.deepEqual(pat, [[90], [90, 90, 90], [260, 110, 260, 110, 260]]);
  // Hard braking now: dots appear at the bottom edge only.
  await page.evaluate(() => (window.__accZ = 2.8));
  await page.waitForFunction(() => Number(document.querySelector('.dots.bottom').dataset.n) >= 2, null, { timeout: 4000 });
  const sides = await page.evaluate(() =>
    ['left', 'right', 'top'].map((s) => document.querySelector(`.dots.${s}`).dataset.n)
  );
  assert.deepEqual(sides, ['0', '0', '0']);
  await page.evaluate(() => (window.__accZ = 0.03));
  await page.waitForFunction(() => document.querySelector('.dots.bottom').dataset.n === '0', null, { timeout: 4000 });
  await endAndSave(page);

  const ride = await page.evaluate(() => window.__andar.store.rides[0]);
  assert.equal(ride.condition, 'cues');
  assert.equal(ride.details.seat, 'front');
  assert.ok(ride.setup.motionSensor, 'motion sensor should be calibrated');
  const turns = ride.cues.filter((c) => c.kind === 'turn');
  assert.ok(turns.length >= 2 && turns.every((c) => c.shown), JSON.stringify(turns));
  assert.match(await page.textContent('#verdict-title'), /Still collecting/);
  assert.match(await page.textContent('#ride-list'), /not counted/); // under 10 minutes

  await page.click('#results [data-nav="home"]');
  assert.equal(await page.textContent('#next-pill'), 'Cues off');

  // Cues-off ride
  await page.evaluate(() => { window.__labels = []; window.__levels = []; });
  await page.click('#go-setup');
  await page.waitForSelector('#setup:not([hidden])');
  assert.match(await page.textContent('#start-condition'), /Cues off/);
  await page.evaluate(() => clearInterval(window.__motion));
  await context.setGeolocation({ latitude: origin.lat, longitude: origin.lon, accuracy: 5 });
  await planAndStart(page);
  assert.equal(await page.textContent('#ride-pill'), 'Cues off');
  await driveRoute(context);
  assert.deepEqual(await page.evaluate(() => window.__labels), [], 'no cue may be shown on a cues-off ride');
  assert.equal(await page.textContent('#ride-next'), '', 'no turn preview on a cues-off ride');
  await endAndSave(page);
  const second = await page.evaluate(() => window.__andar.store.rides[1]);
  assert.equal(second.condition, 'control');
  const hidden = second.cues.filter((c) => c.kind === 'turn');
  assert.ok(hidden.length >= 2 && hidden.every((c) => !c.shown), JSON.stringify(hidden));

  // Data survives a reload.
  await page.reload();
  assert.equal(await page.evaluate(() => window.__andar.store.rides.length), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

/* 4. Results math matches the engine when enough rides exist. */
await check('results screen reports a verdict from seeded rides', async () => {
  const { page, errors } = await newPage();
  await page.evaluate(() => {
    const mk = (condition, peak, i) => ({
      id: `s${condition}${i}`,
      condition,
      demo: false,
      startedAt: Date.UTC(2026, 9, 1 + i, 15),
      endedAt: Date.UTC(2026, 9, 1 + i, 15, 25),
      ratings: [0, 1, peak, 1].map((fms, k) => ({ t: k * 120000, fms })),
      cues: [],
      details: { seat: 'rear', activity: 'phone', road: 'city', stoppedEarly: false, notes: 'seeded, "quoted"' },
      setup: { leadSec: 2, mount: 'upright' },
    });
    const s = window.__andar.store;
    [3, 2, 4, 3, 2, 3].forEach((p, i) => s.rides.push(mk('cues', p, i)));
    [8, 9, 7, 8, 9, 8].forEach((p, i) => s.rides.push(mk('control', p, i + 6)));
    s.settings.safetyAck = true;
    s.save();
  });
  await page.reload();
  await page.click('#go-results');
  assert.match(await page.textContent('#verdict-title'), /Cues helped/);
  assert.equal(await page.textContent('#r-peak-cues'), '2.8');
  assert.equal(await page.textContent('#r-peak-control'), '8.2');
  assert.equal(await page.locator('#plot circle').count(), 12);
  const csv = await page.evaluate(() => {
    // Capture the CSV the download button would produce.
    let text = '';
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      blob.text().then((t) => (window.__csv = t));
      return orig.call(URL, blob);
    };
    document.querySelector('#dl-csv').click();
    return new Promise((r) => setTimeout(() => r(window.__csv), 200));
  });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 13);
  assert.match(lines[1], /"seeded, ""quoted"""/);
  assert.deepEqual(errors, []);
});

/* 5. Phone-width layout never scrolls sideways. */
await check('no horizontal overflow at 360 px on every screen', async () => {
  const { page } = await newPage();
  await page.setViewportSize({ width: 360, height: 740 });
  for (const id of ['home', 'safety', 'setup', 'end', 'results', 'settings', 'ride']) {
    await page.evaluate((sid) => {
      document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== sid));
    }, id);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, `${id} overflows by ${over}px`);
  }
});

await browser.close();
server.close();
for (const r of results) console.log(r.join(' | '));
if (results.some((r) => r[0] === 'FAIL')) process.exit(1);
