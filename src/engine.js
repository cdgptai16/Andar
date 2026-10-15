/*
 * Andar engine — pure logic, no DOM.
 * Shared by the phone app today and the glasses app later.
 *
 *   Geo        distance / projection helpers
 *   buildRoute OSRM response -> route with maneuvers placed along the line
 *   RouteTracker   GPS fixes -> anticipatory turn cues (fired ~leadSec before the turn)
 *   MotionProcessor  phone accelerometer -> car-frame braking / acceleration / turning
 *   Trial      ride summaries, counterbalanced on/off schedule, permutation test
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CueEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ Geo */

  const EARTH_R = 6371008.8; // meters
  const toRad = (d) => (d * Math.PI) / 180;

  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Local flat projection around `origin` (accurate to well under 1 m over a few km).
  function toLocal(p, origin) {
    return {
      x: toRad(p.lon - origin.lon) * Math.cos(toRad(origin.lat)) * EARTH_R,
      y: toRad(p.lat - origin.lat) * EARTH_R,
    };
  }

  // Closest point of p on segment a->b. Returns fraction t in [0,1] and distance (m).
  function projectOnSegment(p, a, b) {
    const pa = toLocal(p, a);
    const ab = toLocal(b, a);
    const len2 = ab.x * ab.x + ab.y * ab.y;
    if (len2 === 0) return { t: 0, dist: Math.hypot(pa.x, pa.y) };
    let t = (pa.x * ab.x + pa.y * ab.y) / len2;
    t = Math.max(0, Math.min(1, t));
    return { t, dist: Math.hypot(pa.x - t * ab.x, pa.y - t * ab.y) };
  }

  function cumulativeLengths(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    return cum;
  }

  // Nearest position along the polyline, searching segments [from, to).
  function locateOnLine(p, coords, cum, from, to) {
    let best = null;
    const lo = Math.max(0, from);
    const hi = Math.min(coords.length - 1, to);
    for (let i = lo; i < hi; i++) {
      const r = projectOnSegment(p, coords[i], coords[i + 1]);
      if (!best || r.dist < best.dist) {
        best = { seg: i, dist: r.dist, s: cum[i] + r.t * (cum[i + 1] - cum[i]) };
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ Maneuvers */

  // Turn an OSRM maneuver into the cue we show, or null if it needs no cue.
  function classifyManeuver(type, modifier) {
    if (type === 'depart') return null;
    if (type === 'arrive') return { dir: 'stop', strength: 'normal', label: 'Arriving' };
    if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
      return { dir: 'roundabout', strength: 'strong', label: 'Roundabout' };
    }
    const mod = modifier || 'straight';
    if (mod === 'uturn') return { dir: 'uturn', strength: 'strong', label: 'U-turn' };
    if (mod === 'straight') return null;
    const dir = mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : null;
    if (!dir) return null;
    const strength = mod.startsWith('slight') ? 'light' : mod.startsWith('sharp') ? 'strong' : 'normal';
    const word = dir === 'left' ? 'Left' : 'Right';
    const label = strength === 'light' ? `Slight ${word.toLowerCase()}` : strength === 'strong' ? `Sharp ${word.toLowerCase()}` : word;
    return { dir, strength, label };
  }

  // OSRM /route response (geometries=geojson, steps=true) -> route.
  function buildRoute(osrm) {
    if (!osrm || osrm.code !== 'Ok' || !osrm.routes || !osrm.routes.length) {
      throw new Error('No drivable route found for that destination.');
    }
    const r = osrm.routes[0];
    const coords = r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
    if (coords.length < 2) throw new Error('Route is too short to track.');
    const cum = cumulativeLengths(coords);
    const maneuvers = [];
    let searchFrom = 0;
    for (const leg of r.legs || []) {
      for (const step of leg.steps || []) {
        const m = step.maneuver || {};
        const cue = classifyManeuver(m.type, m.modifier);
        if (!cue || !m.location) continue;
        const p = { lat: m.location[1], lon: m.location[0] };
        // Maneuvers are in order along the line; search forward to avoid matching an earlier pass.
        const hit = locateOnLine(p, coords, cum, searchFrom, coords.length);
        if (!hit) continue;
        searchFrom = hit.seg;
        maneuvers.push({ ...cue, at: hit.s, road: step.name || '' });
      }
    }
    return { coords, cum, length: cum[cum.length - 1], maneuvers };
  }

  /* --------------------------------------------------------- RouteTracker */

  const TRACKER_DEFAULTS = {
    leadSec: 2.0, // cue this long before the maneuver (research used ~1 s; GPS lag adds ~1 s)
    minSpeed: 1.5, // m/s; below this, ETA is meaningless — use distance instead
    nearDistance: 10, // m; always cue within this distance even at crawling speed
    offRouteMeters: 45,
    offRouteFixes: 3,
    maxAccuracy: 35, // ignore fixes worse than this (m)
  };

  class RouteTracker {
    constructor(route, opts = {}) {
      this.route = route;
      this.o = { ...TRACKER_DEFAULTS, ...opts };
      this.seg = 0;
      this.s = 0;
      this.state = route.maneuvers.map(() => 'pending'); // pending | scheduled | passed
      this.lastFix = null;
      this.badFixes = 0;
      this.offRoute = false;
    }

    // fix: {lat, lon, speed (m/s|null), accuracy (m), t (ms)}; now: ms clock for latency.
    update(fix, now = fix.t) {
      const out = { events: [], offRoute: this.offRoute, s: this.s, next: null };
      if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return out;
      if (Number.isFinite(fix.accuracy) && fix.accuracy > this.o.maxAccuracy) return out;

      const speed = this._speed(fix);
      const { coords, cum } = this.route;
      let hit = locateOnLine(fix, coords, cum, this.seg - 2, this.seg + 40);
      if (!hit || hit.dist > this.o.offRouteMeters) {
        const global = locateOnLine(fix, coords, cum, 0, coords.length);
        if (global && (!hit || global.dist < hit.dist)) hit = global;
      }
      if (!hit) return out;

      if (hit.dist > this.o.offRouteMeters) {
        this.badFixes += 1;
        if (this.badFixes >= this.o.offRouteFixes && !this.offRoute) {
          this.offRoute = true;
          out.events.push({ kind: 'offRoute' });
        }
        out.offRoute = this.offRoute;
        return out;
      }
      this.badFixes = 0;
      if (this.offRoute) {
        this.offRoute = false;
        out.events.push({ kind: 'backOnRoute' });
      }
      this.seg = hit.seg;
      this.s = hit.s;
      out.s = hit.s;
      out.offRoute = false;

      const ageSec = Math.max(0, (now - fix.t) / 1000);
      // Distance already covered since the fix was taken.
      const travelledSinceFix = speed * ageSec;

      this.route.maneuvers.forEach((m, i) => {
        if (this.state[i] !== 'pending') return;
        const dist = m.at - hit.s - travelledSinceFix;
        if (dist < -25) {
          this.state[i] = 'passed';
          return;
        }
        let fireInSec = null;
        if (dist <= this.o.nearDistance) fireInSec = 0;
        else if (speed >= this.o.minSpeed) {
          const eta = dist / speed;
          // Schedule if the cue moment falls before the next fix (~1 s away).
          if (eta - this.o.leadSec <= 1.2) fireInSec = Math.max(0, eta - this.o.leadSec);
        }
        if (fireInSec !== null) {
          this.state[i] = 'scheduled';
          out.events.push({
            kind: 'turn',
            index: i,
            dir: m.dir,
            strength: m.strength,
            label: m.label,
            road: m.road,
            fireInMs: Math.round(fireInSec * 1000),
            distance: Math.round(Math.max(0, dist)),
          });
        }
      });

      const nextIdx = this.state.findIndex((st) => st === 'pending');
      if (nextIdx >= 0) {
        const m = this.route.maneuvers[nextIdx];
        out.next = { index: nextIdx, label: m.label, distance: Math.max(0, Math.round(m.at - hit.s)) };
      }
      return out;
    }

    _speed(fix) {
      let v = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
      if (v === null && this.lastFix && fix.t > this.lastFix.t) {
        v = haversine(this.lastFix, fix) / ((fix.t - this.lastFix.t) / 1000);
      }
      this.lastFix = fix;
      return v === null ? 0 : v;
    }
  }

  /* ------------------------------------------------------ MotionProcessor */

  const vec = {
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: (a) => Math.hypot(a[0], a[1], a[2]),
    unit: (a) => {
      const n = Math.hypot(a[0], a[1], a[2]);
      return n === 0 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
    },
  };

  // Device axes (W3C DeviceMotion): x = right edge, y = top edge, z = out of the screen.
  // "upright": phone stands in a dash/vent mount, screen facing you -> car forward is -z.
  // "flat":    phone lies flat, top edge pointing at the windshield -> car forward is +y.
  const MOUNT_FORWARD = { upright: [0, 0, -1], flat: [0, 1, 0] };

  const MOTION_DEFAULTS = {
    mount: 'upright',
    tauSec: 0.35, // smoothing time constant
    onThreshold: 1.2, // m/s² to start a cue (~0.12 g, a firm stop or brisk turn)
    offThreshold: 0.8,
    fullScale: 3.0, // m/s² that maps to full cue intensity
  };

  class MotionProcessor {
    constructor(opts = {}) {
      this.o = { ...MOTION_DEFAULTS, ...opts };
      this.up = null; // unit vector, device frame
      this.g = 9.80665;
      this.forward = null;
      this.left = null;
      this.flip = 1; // -1 if GPS shows the mount is backwards
      this.f = { long: 0, lat: 0 };
      this.lastT = null;
      this.active = { long: false, lat: false };
    }

    get calibrated() {
      return this.up !== null;
    }

    // samples: [[x,y,z], ...] of accelerationIncludingGravity while the car is still.
    calibrate(samples) {
      if (!samples || samples.length < 10) throw new Error('Not enough motion samples to calibrate.');
      const mean = [0, 0, 0];
      for (const s of samples) for (let k = 0; k < 3; k++) mean[k] += s[k] / samples.length;
      const spread = Math.max(...samples.map((s) => vec.norm(vec.sub(s, mean))));
      if (spread > 1.5) throw new Error('Phone moved during calibration. Hold it still and try again.');
      const g = vec.norm(mean);
      if (g < 8 || g > 11.5) throw new Error('Motion sensor reading looks wrong. Restart the app and retry.');
      this.g = g;
      this.up = vec.unit(mean);
      const hint = MOUNT_FORWARD[this.o.mount];
      if (!hint) throw new Error(`Unknown mount type: ${this.o.mount}`);
      // Forward = mount hint with its vertical part removed.
      const horiz = vec.sub(hint, vec.scale(this.up, vec.dot(hint, this.up)));
      if (vec.norm(horiz) < 0.35) {
        throw new Error('Phone angle does not match the mount type you picked. Check the mount setting.');
      }
      this.forward = vec.unit(horiz);
      this.left = vec.unit(vec.cross(this.up, this.forward));
      this.f = { long: 0, lat: 0 };
      this.lastT = null;
      return { tiltDeg: Math.round((Math.acos(Math.min(1, vec.norm(horiz))) * 180) / Math.PI) };
    }

    // a: [x,y,z] accelerationIncludingGravity, t: ms. Returns car-frame values and cue intensities.
    push(a, t) {
      if (!this.calibrated) return null;
      const lin = vec.sub(a, vec.scale(this.up, this.g));
      const long = vec.dot(lin, this.forward) * this.flip;
      const lat = vec.dot(lin, this.left) * this.flip;
      const dt = this.lastT === null ? 0 : Math.max(0, Math.min(0.5, (t - this.lastT) / 1000));
      this.lastT = t;
      const k = dt === 0 ? 1 : 1 - Math.exp(-dt / this.o.tauSec);
      this.f.long += k * (long - this.f.long);
      this.f.lat += k * (lat - this.f.lat);
      return { long: this.f.long, lat: this.f.lat, cue: this._cue() };
    }

    _cue() {
      const { onThreshold, offThreshold, fullScale } = this.o;
      const pick = (key, value) => {
        const mag = Math.abs(value);
        if (!this.active[key] && mag >= onThreshold) this.active[key] = true;
        else if (this.active[key] && mag < offThreshold) this.active[key] = false;
        if (!this.active[key]) return 0;
        return Math.max(0, Math.min(1, (mag - offThreshold) / (fullScale - offThreshold)));
      };
      const longI = pick('long', this.f.long);
      const latI = pick('lat', this.f.lat);
      return {
        braking: this.f.long < 0 ? longI : 0,
        speeding: this.f.long > 0 ? longI : 0,
        left: this.f.lat > 0 ? latI : 0,
        right: this.f.lat < 0 ? latI : 0,
      };
    }

    // Called by ForwardCheck when GPS proves the mount is reversed.
    reverse() {
      this.flip *= -1;
      this.f = { long: -this.f.long, lat: -this.f.lat };
    }
  }

  // Compares sensor braking/acceleration with GPS speed changes; detects a backwards mount.
  class ForwardCheck {
    constructor({ minDv = 1.0, votes = 5 } = {}) {
      this.minDv = minDv; // m/s² from GPS needed to count a vote
      this.votes = votes;
      this.agree = 0;
      this.disagree = 0;
      this.prev = null;
      this.decided = false;
    }

    // speed: GPS m/s, t: ms, sensorLong: smoothed sensor long accel at t. Returns true if a flip is needed.
    add(speed, t, sensorLong) {
      if (this.decided || !Number.isFinite(speed)) return false;
      const prev = this.prev;
      this.prev = { speed, t };
      if (!prev || t <= prev.t) return false;
      const gpsAccel = (speed - prev.speed) / ((t - prev.t) / 1000);
      if (Math.abs(gpsAccel) < this.minDv || Math.abs(sensorLong) < this.minDv / 2) return false;
      if (Math.sign(gpsAccel) === Math.sign(sensorLong)) this.agree += 1;
      else this.disagree += 1;
      if (this.agree + this.disagree >= this.votes) {
        this.decided = true;
        return this.disagree > this.agree;
      }
      return false;
    }
  }

  /* --------------------------------------------------------------- Trial */

  const MIN_RIDE_MINUTES = 10;
  const MIN_RIDES_PER_ARM = 6;

  // ABBA blocks reduce order effects (getting used to the car, time of day drift).
  function nextCondition(rides) {
    const pattern = ['cues', 'control', 'control', 'cues'];
    const n = rides.filter((r) => !r.demo).length;
    return pattern[n % pattern.length];
  }

  function summarizeRide(ride) {
    const ratings = (ride.ratings || []).map((r) => r.fms).filter(Number.isFinite);
    const minutes = (ride.endedAt - ride.startedAt) / 60000;
    const peak = ratings.length ? Math.max(...ratings) : null;
    const mean = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
    const usable = !ride.demo && minutes >= MIN_RIDE_MINUTES && ratings.length >= 3;
    return { id: ride.id, condition: ride.condition, minutes, peak, mean, ratings: ratings.length, usable };
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  function choose(n, k) {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }

  // One-sided test: are scores lower with cues than without?
  // Returns p = share of label shuffles at least as favourable to cues as what we observed.
  function permutationTest(cues, control, { iterations = 20000, seed = 7 } = {}) {
    const all = cues.concat(control);
    const k = cues.length;
    const total = all.reduce((a, b) => a + b, 0);
    const diffFor = (cueSum) => (total - cueSum) / control.length - cueSum / k;
    const observed = diffFor(cues.reduce((a, b) => a + b, 0));
    const eps = 1e-9;

    if (choose(all.length, k) <= 50000) {
      let hits = 0;
      let count = 0;
      const walk = (start, picked, sum) => {
        if (picked === k) {
          count += 1;
          if (diffFor(sum) >= observed - eps) hits += 1;
          return;
        }
        for (let i = start; i <= all.length - (k - picked); i++) walk(i + 1, picked + 1, sum + all[i]);
      };
      walk(0, 0, 0);
      return { p: hits / count, observed, exact: true };
    }

    const rand = mulberry32(seed);
    const pool = all.slice();
    let hits = 0;
    for (let it = 0; it < iterations; it++) {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      let s = 0;
      for (let i = 0; i < k; i++) s += pool[i];
      if (diffFor(s) >= observed - eps) hits += 1;
    }
    return { p: (hits + 1) / (iterations + 1), observed, exact: false };
  }

  function compare(rides) {
    const sums = rides.map(summarizeRide);
    const usable = sums.filter((s) => s.usable);
    const arm = (c) => usable.filter((s) => s.condition === c);
    const cues = arm('cues');
    const control = arm('control');
    const stat = (xs, key) => (xs.length ? mean(xs.map((x) => x[key])) : null);
    const result = {
      counts: { cues: cues.length, control: control.length, excluded: sums.length - usable.length },
      peak: { cues: stat(cues, 'peak'), control: stat(control, 'peak') },
      mean: { cues: stat(cues, 'mean'), control: stat(control, 'mean') },
      reductionPct: null,
      p: null,
      verdict: 'collecting',
      message: '',
    };
    const need = MIN_RIDES_PER_ARM;
    if (cues.length < need || control.length < need) {
      result.message = `Keep riding. You need at least ${need} usable rides in each mode (have ${cues.length} with cues, ${control.length} without).`;
      return result;
    }
    const test = permutationTest(cues.map((c) => c.peak), control.map((c) => c.peak));
    result.p = test.p;
    result.reductionPct = result.peak.control > 0 ? ((result.peak.control - result.peak.cues) / result.peak.control) * 100 : null;
    if (test.p < 0.05 && result.reductionPct !== null && result.reductionPct >= 20) {
      result.verdict = 'helped';
      result.message = `Cues lowered your peak sickness by about ${Math.round(result.reductionPct)}%. That is unlikely to be chance (p = ${test.p.toFixed(3)}). Worth porting to the glasses.`;
    } else if (result.reductionPct !== null && result.reductionPct <= 0) {
      result.verdict = 'no-benefit';
      result.message = 'Rides with cues were no better than rides without. Cues in this form are not helping you.';
    } else {
      result.verdict = 'unclear';
      result.message = `There may be a small effect (${Math.round(result.reductionPct || 0)}% lower peak), but it could be chance (p = ${test.p.toFixed(3)}). Add 4 more rides in each mode.`;
    }
    return result;
  }

  /* ------------------------------------------------------------ Simulator */

  // A short synthetic drive for the demo mode and tests: straight, left, straight, right, stop.
  function demoDrive({ origin = { lat: 33.0198, lon: -96.6989 }, speed = 12 } = {}) {
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(toRad(origin.lat));
    const pt = (east, north) => ({ lat: origin.lat + north / mPerDegLat, lon: origin.lon + east / mPerDegLon });
    // Heading north 400 m, left (west) 300 m, right (north) 300 m.
    const corners = [pt(0, 0), pt(0, 400), pt(-300, 400), pt(-300, 700)];
    const osrm = {
      code: 'Ok',
      routes: [
        {
          geometry: { coordinates: corners.map((c) => [c.lon, c.lat]) },
          legs: [
            {
              steps: [
                { name: 'Demo Ave', maneuver: { type: 'depart', location: [corners[0].lon, corners[0].lat] } },
                { name: 'Sample St', maneuver: { type: 'turn', modifier: 'left', location: [corners[1].lon, corners[1].lat] } },
                { name: 'Test Rd', maneuver: { type: 'turn', modifier: 'right', location: [corners[2].lon, corners[2].lat] } },
                { name: '', maneuver: { type: 'arrive', location: [corners[3].lon, corners[3].lat] } },
              ],
            },
          ],
        },
      ],
    };
    // Per-second fixes plus the car-frame acceleration at that second.
    const legs = [
      { from: [0, 0], to: [0, 400] },
      { from: [0, 400], to: [-300, 400] },
      { from: [-300, 400], to: [-300, 700] },
    ];
    const timeline = [];
    let t = 0;
    legs.forEach((leg, li) => {
      const len = Math.hypot(leg.to[0] - leg.from[0], leg.to[1] - leg.from[1]);
      const steps = Math.round(len / speed);
      for (let i = 0; i < steps; i++) {
        const f = i / steps;
        const e = leg.from[0] + (leg.to[0] - leg.from[0]) * f;
        const n = leg.from[1] + (leg.to[1] - leg.from[1]) * f;
        const secondsLeft = steps - i;
        // Brake for the last 3 s before each corner/stop, turn for the first 2 s after one.
        let long = 0;
        let lat = 0;
        if (secondsLeft <= 3) long = -2.2;
        if (li > 0 && i < 2) lat = li === 1 ? 2.6 : -2.6; // + = left
        timeline.push({ t, fix: { ...pt(e, n), speed, accuracy: 6 }, long, lat });
        t += 1000;
      }
    });
    return { osrm, timeline };
  }

  return {
    haversine,
    projectOnSegment,
    classifyManeuver,
    buildRoute,
    RouteTracker,
    MotionProcessor,
    ForwardCheck,
    MOUNT_FORWARD,
    nextCondition,
    summarizeRide,
    permutationTest,
    compare,
    demoDrive,
    MIN_RIDE_MINUTES,
    MIN_RIDES_PER_ARM,
  };
});
