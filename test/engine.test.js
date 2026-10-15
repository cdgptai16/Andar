'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected}±${tol}, got ${actual}`);

/* ----------------------------------------------------------------- Geo */

test('haversine: 1 degree of latitude is ~111.2 km', () => {
  near(E.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195, 50);
});

test('projectOnSegment clamps to the segment ends', () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 0.001 };
  assert.equal(E.projectOnSegment({ lat: 0, lon: -0.001 }, a, b).t, 0);
  assert.equal(E.projectOnSegment({ lat: 0, lon: 0.002 }, a, b).t, 1);
  near(E.projectOnSegment({ lat: 0, lon: 0.0005 }, a, b).t, 0.5, 1e-6);
});

/* ----------------------------------------------------------- Maneuvers */

test('classifyManeuver maps OSRM types to cues', () => {
  assert.equal(E.classifyManeuver('depart'), null);
  assert.equal(E.classifyManeuver('turn', 'straight'), null);
  assert.equal(E.classifyManeuver('new name', undefined), null);
  assert.deepEqual(E.classifyManeuver('turn', 'left'), { dir: 'left', strength: 'normal', level: 2, label: 'Left' });
  assert.equal(E.classifyManeuver('turn', 'slight right').level, 1);
  assert.equal(E.classifyManeuver('turn', 'slight right').label, 'Slight right');
  assert.equal(E.classifyManeuver('turn', 'sharp left').level, 3);
  assert.equal(E.classifyManeuver('turn', 'sharp left').label, 'Sharp left');
  assert.equal(E.classifyManeuver('roundabout', 'right').level, 3);
  assert.equal(E.classifyManeuver('turn', 'uturn').dir, 'uturn');
  assert.equal(E.classifyManeuver('roundabout', 'right').dir, 'roundabout');
  assert.equal(E.classifyManeuver('arrive').dir, 'stop');
});

test('buildRoute places maneuvers at their distance along the line', () => {
  const { osrm } = E.demoDrive();
  const r = E.buildRoute(osrm);
  assert.deepEqual(r.maneuvers.map((m) => m.dir), ['left', 'right', 'stop']);
  near(r.maneuvers[0].at, 400, 2);
  near(r.maneuvers[1].at, 700, 2);
  near(r.maneuvers[2].at, 1000, 2);
  near(r.length, 1000, 2);
});

test('buildRoute rejects a failed or empty response', () => {
  assert.throws(() => E.buildRoute({ code: 'NoRoute', routes: [] }), /No drivable route/);
  assert.throws(() => E.buildRoute(null), /No drivable route/);
});

/* -------------------------------------------------------- RouteTracker */

function runDrive(opts = {}, mutateFix = (f) => f) {
  const { osrm, timeline } = E.demoDrive({ speed: opts.speed || 12 });
  const route = E.buildRoute(osrm);
  const tracker = new E.RouteTracker(route, opts.tracker);
  const fired = [];
  const ages = opts.ageMs || 0;
  for (const step of timeline) {
    const fix = mutateFix({ ...step.fix, t: step.t });
    const res = tracker.update(fix, step.t + ages);
    for (const ev of res.events) if (ev.kind === 'turn') fired.push({ ...ev, at: step.t + ages + ev.fireInMs });
  }
  return { fired, route };
}

test('RouteTracker cues each maneuver once, in order, about leadSec early', () => {
  const speed = 12;
  const { fired, route } = runDrive({ speed, tracker: { leadSec: 2 } });
  assert.deepEqual(fired.map((f) => f.dir), ['left', 'right', 'stop']);
  assert.deepEqual(fired.map((f) => f.level), [2, 3, 2], 'demo has a normal left and a sharp right');
  // The car reaches maneuver i at (at / speed) seconds. Steps are whole seconds, so allow ~1 s.
  route.maneuvers.forEach((m, i) => {
    const arrivalMs = (m.at / speed) * 1000;
    near(fired[i].at, arrivalMs - 2000, 1100, `maneuver ${m.dir}`);
  });
});

test('RouteTracker compensates for GPS fix age', () => {
  const fresh = runDrive({ tracker: { leadSec: 2 } }).fired;
  const stale = runDrive({ tracker: { leadSec: 2 }, ageMs: 800 }).fired;
  // Cue moment in wall-clock time should land at nearly the same instant despite stale fixes.
  fresh.forEach((f, i) => near(stale[i].at, f.at, 1100, `maneuver ${i}`));
});

test('RouteTracker derives speed from fixes when the GPS gives none', () => {
  const { fired } = runDrive({}, (f) => ({ ...f, speed: null }));
  assert.deepEqual(fired.map((f) => f.dir), ['left', 'right', 'stop']);
});

test('RouteTracker ignores inaccurate fixes', () => {
  const { osrm } = E.demoDrive();
  const tracker = new E.RouteTracker(E.buildRoute(osrm));
  const res = tracker.update({ lat: 33.0198, lon: -96.6989, speed: 10, accuracy: 120, t: 0 });
  assert.equal(res.events.length, 0);
  assert.equal(tracker.s, 0);
});

test('RouteTracker reports leaving and rejoining the route', () => {
  const { osrm, timeline } = E.demoDrive();
  const tracker = new E.RouteTracker(E.buildRoute(osrm));
  tracker.update({ ...timeline[0].fix, t: 0 });
  const kinds = [];
  for (let i = 1; i <= 3; i++) {
    const off = { ...timeline[i].fix, lon: timeline[i].fix.lon + 0.003, t: i * 1000 }; // ~280 m east
    kinds.push(...tracker.update(off).events.map((e) => e.kind));
  }
  assert.deepEqual(kinds, ['offRoute']);
  const back = tracker.update({ ...timeline[5].fix, t: 5000 });
  assert.deepEqual(back.events.map((e) => e.kind), ['backOnRoute']);
});

test('RouteTracker cues a turn at crawling speed once close enough', () => {
  const { osrm } = E.demoDrive();
  const route = E.buildRoute(osrm);
  const tracker = new E.RouteTracker(route);
  const corner = route.coords[1];
  const res = tracker.update({ lat: corner.lat - 5 / 111320, lon: corner.lon, speed: 0.5, accuracy: 5, t: 0 });
  assert.equal(res.events[0].dir, 'left');
  assert.equal(res.events[0].fireInMs, 0);
});

test('dotCount maps movement strength to 0–3 dots', () => {
  assert.equal(E.dotCount(0), 0);
  assert.equal(E.dotCount(undefined), 0);
  assert.equal(E.dotCount(NaN), 0);
  assert.equal(E.dotCount(0.1), 1);
  assert.equal(E.dotCount(0.5), 2);
  assert.equal(E.dotCount(0.9), 3);
  assert.equal(E.dotCount(1), 3);
});

/* -------------------------------------------------------- SceneryModel */

// Drive the model at 60 Hz for `sec` seconds with a constant car motion.
function runScenery(model, sec, fast, { gpsSpeed = null, gpsAccel = 0, t0 = 0 } = {}) {
  let out;
  let v = gpsSpeed;
  const dt = 1000 / 60;
  let t = t0;
  for (let i = 0; i < Math.round((sec * 1000) / dt); i++) {
    t += dt;
    if (v !== null && i % 60 === 0) {
      model.gps({ speed: v, accuracy: 5, fixT: t, now: t });
      v += gpsAccel;
    }
    model.motion(fast, t);
    out = model.step(dt / 1000);
  }
  return { out, t };
}

test('SceneryModel: left turn sweeps dots right, right turn sweeps them left', () => {
  const m = new E.SceneryModel();
  const left = runScenery(m, 1, { long: 0, lat: 2, yaw: 20 }).out;
  assert.ok(left.vx > 80 && left.vy === 0, JSON.stringify(left));
  assert.ok(left.scrollX > 60, 'dots kept moving through the turn');
  assert.ok(left.opacity > 0.9);
  const r = new E.SceneryModel();
  assert.ok(runScenery(r, 1, { long: 0, lat: -2, yaw: -20 }).out.vx < -80);
});

test('SceneryModel: braking streams dots up, speeding up streams them down', () => {
  const brake = runScenery(new E.SceneryModel(), 1, { long: -3, lat: 0, yaw: 0 }).out;
  assert.ok(brake.vy < -60 && brake.vx === 0, JSON.stringify(brake));
  const go = runScenery(new E.SceneryModel(), 1, { long: 2, lat: 0, yaw: 0 }).out;
  assert.ok(go.vy > 40);
});

test('SceneryModel: steady straight driving shows nothing; dots fade ~1–2 s after a maneuver', () => {
  const m = new E.SceneryModel();
  let r = runScenery(m, 3, { long: 0.15, lat: 0.1, yaw: 1 }); // road texture, lane drift
  assert.equal(r.out.opacity, 0);
  assert.equal(r.out.vx, 0);
  assert.equal(r.out.vy, 0);
  r = runScenery(m, 1, { long: 0, lat: 2, yaw: 20 }, { t0: r.t });
  assert.ok(r.out.opacity > 0.9);
  r = runScenery(m, 0.5, { long: 0, lat: 0, yaw: 0 }, { t0: r.t });
  assert.ok(r.out.opacity > 0.2, 'still fading, not cut off');
  r = runScenery(m, 3, { long: 0, lat: 0, yaw: 0 }, { t0: r.t });
  assert.equal(r.out.opacity, 0);
});

test('SceneryModel: dots appear within ~0.15 s of a sudden maneuver', () => {
  const m = new E.SceneryModel();
  const r = runScenery(m, 0.15, { long: -3, lat: 0, yaw: 0 });
  assert.ok(r.out.opacity > 0.6, `opacity ${r.out.opacity.toFixed(2)}`);
});

test('SceneryModel: a long hill does not leave dots streaming (GPS says speed is constant)', () => {
  const m = new E.SceneryModel();
  // 5% grade reads as a constant 0.49 m/s² "push" to the accelerometer.
  const early = runScenery(m, 1, { long: 0.49, lat: 0, yaw: 0 }, { gpsSpeed: 15, gpsAccel: 0 });
  assert.ok(early.out.vy > 0, 'first reads as speeding up');
  const late = runScenery(m, 25, { long: 0.49, lat: 0, yaw: 0 }, { gpsSpeed: 15, gpsAccel: 0, t0: early.t });
  assert.equal(late.out.vy, 0);
  assert.equal(late.out.opacity, 0);
});

test('SceneryModel: real braking survives the hill correction (GPS agrees it is braking)', () => {
  const m = new E.SceneryModel();
  const r = runScenery(m, 4, { long: -3, lat: 0, yaw: 0 }, { gpsSpeed: 20, gpsAccel: -3 });
  assert.ok(r.out.vy < -80, `still streaming up after 4 s of braking: ${r.out.vy.toFixed(0)}`);
});

test('SceneryModel: without a gyroscope, turn rate comes from sideways push and speed', () => {
  const m = new E.SceneryModel();
  m.gps({ speed: 10, accuracy: 5, fixT: 0, now: 0 });
  const r = runScenery(m, 1, { long: 0, lat: 3, yaw: null }).out; // 3 m/s² at 10 m/s = 17°/s left
  assert.ok(r.vx > 60, JSON.stringify(r));
});

test('SceneryModel: detects a browser reporting the gyroscope in rad/s', () => {
  const m = new E.SceneryModel();
  m.gps({ speed: 10, accuracy: 5, fixT: 0, now: 0 });
  // True turn ~17°/s, but the browser reports 0.3 (rad/s).
  const r = runScenery(m, 1.5, { long: 0, lat: 3, yaw: 0.3 }).out;
  assert.ok(m.gyroScale > 50, 'switched to rad/s');
  assert.ok(r.vx > 60, JSON.stringify(r));
});

test('MotionProcessor reports turn rate from the gyroscope, independent of mount direction', () => {
  const p = new E.MotionProcessor({ mount: 'upright' });
  p.calibrate(still('upright')); // up = +y
  let out;
  for (let t = 0; t <= 500; t += 16) out = p.push(reading(p, 'upright', 0, 0), t, [0, 20, 0]);
  assert.ok(Math.abs(out.fast.yaw - 20) < 0.5, `yaw ${out.fast.yaw}`);
  p.reverse(); // backwards mount detected later: turn direction must not flip
  for (let t = 516; t <= 1000; t += 16) out = p.push(reading(p, 'upright', 0, 0), t, [0, 20, 0]);
  assert.ok(Math.abs(out.fast.yaw - 20) < 0.5);
});

/* ----------------------------------------------------- MotionProcessor */

const G = 9.80665;
function reading(proc, mount, carLong, carLat, noise = 0) {
  // Build the accelerometer reading a phone would report for a given car acceleration.
  const up = mount === 'upright' ? [0, 1, 0] : [0, 0, 1];
  const forward = E.MOUNT_FORWARD[mount];
  const left = [-1, 0, 0];
  return [0, 1, 2].map((k) => up[k] * G + forward[k] * carLong + left[k] * carLat + noise);
}
const still = (mount) => Array.from({ length: 30 }, () => reading(null, mount, 0, 0));

for (const mount of ['upright', 'flat']) {
  test(`MotionProcessor (${mount}) reports braking, speeding up and turning in the car's frame`, () => {
    const p = new E.MotionProcessor({ mount });
    p.calibrate(still(mount));
    let out;
    for (let t = 0; t <= 2000; t += 20) out = p.push(reading(p, mount, -2.5, 0), t);
    near(out.long, -2.5, 0.05);
    assert.ok(out.cue.braking > 0.5 && out.cue.speeding === 0);

    const q = new E.MotionProcessor({ mount });
    q.calibrate(still(mount));
    for (let t = 0; t <= 2000; t += 20) out = q.push(reading(q, mount, 0, 2.5), t);
    near(out.lat, 2.5, 0.05);
    assert.ok(out.cue.left > 0.5 && out.cue.right === 0);
  });
}

test('MotionProcessor works with a tilted mount', () => {
  // Upright phone leaned back 25°: gravity splits between y and z.
  const a = (25 * Math.PI) / 180;
  const up = [0, Math.cos(a), -Math.sin(a)];
  const samples = Array.from({ length: 20 }, () => up.map((u) => u * G));
  const p = new E.MotionProcessor({ mount: 'upright' });
  const info = p.calibrate(samples);
  assert.ok(info.tiltDeg >= 20 && info.tiltDeg <= 30, `tilt ${info.tiltDeg}`);
  // Braking: kinematic acceleration points backward (opposite of p.forward).
  let out;
  for (let t = 0; t <= 2000; t += 20) {
    out = p.push(up.map((u, k) => u * G - p.forward[k] * 2.0), t);
  }
  near(out.long, -2.0, 0.05);
});

test('MotionProcessor fast signal tracks motion almost immediately', () => {
  const p = new E.MotionProcessor({ mount: 'flat' });
  p.calibrate(still('flat'));
  let out = p.push(reading(p, 'flat', 0, 0), 0);
  // Sudden 2.5 m/s² brake, sampled at 60 Hz. After 100 ms:
  for (let t = 1000 / 60; t <= 100; t += 1000 / 60) out = p.push(reading(p, 'flat', -2.5, 0), t);
  assert.ok(out.fast.long < -1.8, `fast signal should be >70% there, got ${out.fast.long.toFixed(2)}`);
  assert.ok(out.long > -1.0, `cue signal stays steady, got ${out.long.toFixed(2)}`);
  // And it lets go just as fast when the push stops.
  for (let t = 100 + 1000 / 60; t <= 200; t += 1000 / 60) out = p.push(reading(p, 'flat', 0, 0), t);
  assert.ok(Math.abs(out.fast.long) < 0.7, `fast signal released, got ${out.fast.long.toFixed(2)}`);
});

test('MotionProcessor rejects bad calibration', () => {
  const p = new E.MotionProcessor({ mount: 'upright' });
  assert.throws(() => p.calibrate([[0, G, 0]]), /Not enough/);
  const shaky = Array.from({ length: 20 }, (_, i) => [0, G + (i % 2 ? 3 : -3), 0]);
  assert.throws(() => p.calibrate(shaky), /moved/);
  // Phone lying flat but "upright" selected: forward hint -z is vertical.
  assert.throws(() => p.calibrate(still('flat')), /angle does not match/);
});

test('MotionProcessor ignores small bumps and uses hysteresis', () => {
  const p = new E.MotionProcessor({ mount: 'flat' });
  p.calibrate(still('flat'));
  let out;
  for (let t = 0; t <= 2000; t += 20) out = p.push(reading(p, 'flat', -0.6, 0), t);
  assert.equal(out.cue.braking, 0, 'gentle slowing should not cue');
  for (let t = 2020; t <= 4000; t += 20) out = p.push(reading(p, 'flat', -1.5, 0), t);
  assert.ok(out.cue.braking > 0);
  // 1.0 is below "on" but above "off": stays on.
  for (let t = 4020; t <= 6000; t += 20) out = p.push(reading(p, 'flat', -1.0, 0), t);
  assert.ok(out.cue.braking > 0);
  for (let t = 6020; t <= 8000; t += 20) out = p.push(reading(p, 'flat', -0.3, 0), t);
  assert.equal(out.cue.braking, 0);
});

test('ForwardCheck detects a reversed mount from GPS speed changes', () => {
  const check = new E.ForwardCheck({ votes: 5 });
  let flip = false;
  let t = 0;
  let v = 20;
  for (let i = 0; i < 10 && !flip; i++) {
    v -= 2; // GPS: braking at 2 m/s²
    t += 1000;
    flip = check.add(v, t, +1.8); // sensor says speeding up -> mount is backwards
  }
  assert.equal(flip, true);

  const ok = new E.ForwardCheck({ votes: 5 });
  let res = false;
  v = 20;
  t = 0;
  for (let i = 0; i < 10; i++) {
    v -= 2;
    t += 1000;
    res = ok.add(v, t, -1.8) || res;
  }
  assert.equal(res, false);
  assert.equal(ok.decided, true);
});

test('MotionProcessor.reverse flips the reported direction', () => {
  const p = new E.MotionProcessor({ mount: 'flat' });
  p.calibrate(still('flat'));
  p.reverse();
  let out;
  for (let t = 0; t <= 2000; t += 20) out = p.push(reading(p, 'flat', -2.5, 0), t);
  near(out.long, 2.5, 0.05);
});

/* --------------------------------------------------------------- Trial */

const ride = (condition, peak, opts = {}) => ({
  id: Math.random().toString(36),
  condition,
  startedAt: 0,
  endedAt: (opts.minutes ?? 20) * 60000,
  demo: !!opts.demo,
  ratings: Array.from({ length: opts.count ?? 6 }, (_, i) => ({ t: i, fms: i === 0 ? peak : Math.min(peak, 1) })),
});

test('nextCondition follows ABBA blocks and ignores demo rides', () => {
  const seq = [];
  const rides = [];
  for (let i = 0; i < 8; i++) {
    const c = E.nextCondition(rides);
    seq.push(c);
    rides.push(ride(c, 3));
    rides.push(ride(c, 3, { demo: true }));
  }
  assert.deepEqual(seq, ['cues', 'control', 'control', 'cues', 'cues', 'control', 'control', 'cues']);
});

test('summarizeRide excludes short, sparse and demo rides', () => {
  assert.equal(E.summarizeRide(ride('cues', 5)).usable, true);
  assert.equal(E.summarizeRide(ride('cues', 5, { minutes: 6 })).usable, false);
  assert.equal(E.summarizeRide(ride('cues', 5, { count: 2 })).usable, false);
  assert.equal(E.summarizeRide(ride('cues', 5, { demo: true })).usable, false);
  assert.equal(E.summarizeRide(ride('cues', 7)).peak, 7);
});

test('permutationTest: exact p for a perfectly separated small sample', () => {
  const r = E.permutationTest([1, 1, 1], [5, 5, 5]);
  assert.equal(r.exact, true);
  near(r.p, 1 / 20, 1e-9);
  assert.equal(r.observed, 4);
});

test('permutationTest: no difference gives p = 1', () => {
  assert.equal(E.permutationTest([3, 3, 3], [3, 3, 3]).p, 1);
});

test('permutationTest: Monte Carlo path for larger samples is deterministic', () => {
  const cues = [2, 3, 2, 4, 3, 2, 3, 2, 3, 2];
  const control = [6, 7, 5, 8, 6, 7, 6, 5, 7, 6];
  const a = E.permutationTest(cues, control);
  const b = E.permutationTest(cues, control);
  assert.equal(a.exact, false);
  assert.equal(a.p, b.p);
  assert.ok(a.p < 0.001);
});

test('compare: asks for more rides until each arm has enough', () => {
  const rides = [ride('cues', 2), ride('control', 8)];
  const r = E.compare(rides);
  assert.equal(r.verdict, 'collecting');
  assert.match(r.message, /at least 6/);
});

test('compare: clear benefit, no benefit and unclear outcomes', () => {
  const make = (cuePeaks, controlPeaks) => [
    ...cuePeaks.map((p) => ride('cues', p)),
    ...controlPeaks.map((p) => ride('control', p)),
  ];
  const helped = E.compare(make([2, 3, 2, 3, 2, 3], [8, 9, 7, 8, 9, 8]));
  assert.equal(helped.verdict, 'helped');
  assert.ok(helped.reductionPct > 60);

  const none = E.compare(make([8, 9, 7, 8, 9, 8], [8, 7, 7, 8, 8, 8]));
  assert.equal(none.verdict, 'no-benefit');

  const unclear = E.compare(make([6, 8, 5, 9, 6, 7], [7, 8, 6, 9, 8, 7]));
  assert.equal(unclear.verdict, 'unclear');
  assert.equal(unclear.counts.cues, 6);
});
