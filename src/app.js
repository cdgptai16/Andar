/* Andar phone app. All decision logic lives in engine.js (CueEngine); this file is I/O and UI. */
(function () {
  'use strict';
  const E = window.CueEngine;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  /* ------------------------------------------------------------ Storage */

  const KEY = 'andar.v1';
  const DEFAULT_SETTINGS = {
    mount: 'upright',
    leadSec: 2,
    ratingEveryMin: 2,
    vibrate: true,
    motionCues: true,
    colorLevels: false,
    debug: false,
    safetyAck: false,
  };
  const store = {
    settings: { ...DEFAULT_SETTINGS },
    rides: [],
    load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        this.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        this.rides = Array.isArray(data.rides) ? data.rides : [];
      } catch (_) {
        /* Corrupt or blocked storage: start clean, keep running. */
      }
    },
    save() {
      try {
        localStorage.setItem(KEY, JSON.stringify({ settings: this.settings, rides: this.rides }));
        return true;
      } catch (_) {
        toast('This phone would not save your data. Download it from Results now.');
        return false;
      }
    },
  };

  /* ----------------------------------------------------------------- UI */

  let toastTimer = null;
  function toast(msg, ms = 3500) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  const renderers = {};
  function show(id) {
    $$('.screen').forEach((s) => (s.hidden = s.id !== id));
    window.scrollTo(0, 0);
    if (renderers[id]) renderers[id]();
  }
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) show(nav.dataset.nav);
  });

  // Two-tap confirmation, since the frame and many phones suppress confirm().
  function confirmTap(btn, label, action) {
    if (btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.textContent = btn.dataset.label;
      action();
      return;
    }
    btn.dataset.label = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = label;
    setTimeout(() => {
      if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = btn.dataset.label;
      }
    }, 4000);
  }

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmt1 = (x) => (x === null || x === undefined ? '–' : (Math.round(x * 10) / 10).toFixed(1));
  const conditionLabel = (c) => (c === 'cues' ? 'Cues on' : 'Cues off');

  /* ------------------------------------------------------------ Haptics */

  // Direction by pulse length (left short, right long); strength by pulse count (1–3),
  // matching the number of chevrons on screen.
  function hapticPattern(dir, level = 2) {
    const n = Math.max(1, Math.min(3, level));
    const train = (on, gap) => Array.from({ length: n * 2 - 1 }, (_, i) => (i % 2 === 0 ? on : gap));
    if (dir === 'left') return train(90, 90);
    if (dir === 'right') return train(260, 110);
    if (dir === 'roundabout') return [90, 90, 260, 110, 90];
    if (dir === 'uturn') return [260, 110, 260, 110, 260];
    if (dir === 'stop') return [600];
    if (dir === 'prompt') return [40];
    return [120];
  }
  function buzz(name, level) {
    if (!store.settings.vibrate || typeof navigator.vibrate !== 'function') return;
    try {
      navigator.vibrate(hapticPattern(name, level));
    } catch (_) {
      /* Some browsers throw if called without user activation; cues still show on screen. */
    }
  }

  /* ---------------------------------------------------------- Cue view */

  let turnTimer = null;
  function showTurn(ev) {
    const el = $('#turn-cue');
    el.dataset.dir = ev.dir;
    el.dataset.level = String(ev.level || 2);
    $('#turn-label').textContent = ev.road && ev.dir !== 'stop' ? `${ev.label} onto ${ev.road}` : ev.label;
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
    clearTimeout(turnTimer);
    turnTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  // Scenery dots: a canvas redrawn every screen frame from session.scenery (engine
  // SceneryModel). Like Apple's Vehicle Motion Cues, a sparse, staggered set of dots sits in
  // a narrow strip on the left and right edges and scrolls with the car, so it reads as
  // scenery passing in your peripheral vision without covering the middle of the screen.
  const scenery = { raf: null, lastTs: null, ctx: null, w: 0, h: 0, bands: null, color: '#46d9b4' };
  const DOT_GAP_X = 30; // between columns
  const DOT_GAP_Y = 56; // between dots in a column; every other column is offset by half
  const DOT_R = 4.5;
  const EDGE_FADE = 22; // px over which dots fade at a strip's open edges (no popping)
  const GAP_FADE = 14; // px over which dots fade next to the turn chevrons

  function layoutScenery() {
    const canvas = $('#scenery-canvas');
    const ride = $('#ride');
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = ride.clientWidth;
    const h = ride.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const hudBottom = $('#ride .hud').getBoundingClientRect().bottom - ride.getBoundingClientRect().top;
    const ctlTop = $('#ride .controls').getBoundingClientRect().top - ride.getBoundingClientRect().top;
    const top = hudBottom + 8;
    const bottom = ctlTop - 8;
    const side = Math.max(56, Math.min(72, w * 0.16)); // about two columns
    scenery.ctx = ctx;
    scenery.w = w;
    scenery.h = h;
    // Dots enter from the screen edge and fade out at the strip's other three edges.
    scenery.bands = [
      { x0: 0, x1: side, y0: top, y1: bottom, fadeL: false, fadeR: true },
      { x0: w - side, x1: w, y0: top, y1: bottom, fadeL: true, fadeR: false },
    ];
    scenery.color = getComputedStyle(document.documentElement).getPropertyValue('--cue').trim() || scenery.color;
  }

  // While a turn warning shows, leave a clear gap where the chevrons are so both stay readable.
  function chevronGaps() {
    if (!$('#turn-cue').classList.contains('show')) return [];
    const base = $('#ride').getBoundingClientRect();
    return $$('#turn-cue .chev')
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [r.left - base.left - 10, r.right - base.left + 10, r.top - base.top - 10, r.bottom - base.top + 10];
      });
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // Distance from a point to a rectangle [x0, x1, y0, y1]; 0 inside it.
  const rectDist = (x, y, [x0, x1, y0, y1]) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));

  function drawScenery(out) {
    const { ctx, bands } = scenery;
    ctx.clearRect(0, 0, scenery.w, scenery.h);
    if (out.opacity <= 0) return;
    const gaps = chevronGaps();
    // The pattern is anchored to the road (scroll), so each dot keeps its place in the
    // stagger as it travels; only the visible window is computed.
    const colShift = Math.floor(out.scrollX / DOT_GAP_X);
    const ox = out.scrollX - colShift * DOT_GAP_X;
    ctx.fillStyle = scenery.color;
    for (const b of bands) {
      for (let i = Math.floor((b.x0 - ox) / DOT_GAP_X); i <= Math.ceil((b.x1 - ox) / DOT_GAP_X); i++) {
        const x = ox + i * DOT_GAP_X;
        if (x < b.x0 - DOT_R || x > b.x1) continue;
        const stagger = (i - colShift) & 1 ? DOT_GAP_Y / 2 : 0;
        const sy = out.scrollY + stagger;
        const oy = sy - Math.floor(sy / DOT_GAP_Y) * DOT_GAP_Y;
        for (let j = Math.floor((b.y0 - oy) / DOT_GAP_Y); j <= Math.ceil((b.y1 - oy) / DOT_GAP_Y); j++) {
          const y = oy + j * DOT_GAP_Y;
          if (y < b.y0 || y > b.y1) continue;
          // Fade toward every open edge of the strip and around the chevrons, so dots
          // glide in and out of view instead of popping.
          let a = clamp01(Math.min(y - b.y0, b.y1 - y) / EDGE_FADE);
          if (b.fadeR) a *= clamp01((b.x1 - x) / EDGE_FADE);
          if (b.fadeL) a *= clamp01((x - b.x0) / EDGE_FADE);
          for (const g of gaps) a *= clamp01(rectDist(x, y, g) / GAP_FADE);
          if (a <= 0.01) continue;
          ctx.globalAlpha = a * 0.9;
          ctx.beginPath();
          ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function sceneryFrame(ts) {
    scenery.raf = requestAnimationFrame(sceneryFrame);
    if (!session || !session.scenery) return;
    const dt = scenery.lastTs === null ? 0 : (ts - scenery.lastTs) / 1000;
    scenery.lastTs = ts;
    const out = session.scenery.step(dt);
    const el = $('#scenery');
    el.style.opacity = out.opacity.toFixed(3);
    el.dataset.vx = out.vx.toFixed(1);
    el.dataset.vy = out.vy.toFixed(1);
    el.dataset.scrollX = out.scrollX.toFixed(1);
    el.dataset.scrollY = out.scrollY.toFixed(1);
    drawScenery(out);
  }

  function startScenery() {
    stopScenery();
    layoutScenery();
    scenery.lastTs = null;
    scenery.raf = requestAnimationFrame(sceneryFrame);
  }
  function stopScenery() {
    if (scenery.raf !== null) cancelAnimationFrame(scenery.raf);
    scenery.raf = null;
    const el = $('#scenery');
    el.style.opacity = '0';
    if (scenery.ctx) scenery.ctx.clearRect(0, 0, scenery.w, scenery.h);
  }
  window.addEventListener('resize', () => {
    if (scenery.raf !== null) layoutScenery();
  });

  /* ------------------------------------------------------------- Sensors */

  const gps = { last: null, watchId: null, listeners: new Set() };
  function startGps() {
    if (gps.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      setGpsStatus('bad', 'This browser has no location access. Use Chrome on Android.');
      return;
    }
    gps.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        gps.last = {
          lat: c.latitude,
          lon: c.longitude,
          accuracy: c.accuracy,
          speed: Number.isFinite(c.speed) ? c.speed : null,
          t: pos.timestamp || Date.now(),
        };
        gps.listeners.forEach((fn) => fn(gps.last));
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? 'Location is blocked. Allow location for this site in Chrome settings, then reload.'
            : 'Cannot get a location fix yet. Make sure location is on.';
        gps.listeners.forEach((fn) => fn(null, msg));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }
  function setGpsStatus(kind, text) {
    $('#gps-dot').className = `dot ${kind}`;
    $('#gps-text').textContent = text;
  }

  const motion = { listeners: new Set(), seen: false };
  function onDeviceMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return;
    motion.seen = true;
    const sample = [a.x, a.y, a.z];
    const r = e.rotationRate;
    // rotationRate alpha/beta/gamma = deg/s about device z/x/y; reorder to [x, y, z].
    const rot = r && [r.beta, r.gamma, r.alpha].every(Number.isFinite) ? [r.beta, r.gamma, r.alpha] : null;
    const t = performance.now();
    motion.listeners.forEach((fn) => fn(sample, t, rot));
  }
  async function startMotion() {
    // iPhone needs an explicit permission tap; Android does not.
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') return false;
      } catch (_) {
        return false;
      }
    }
    window.removeEventListener('devicemotion', onDeviceMotion);
    window.addEventListener('devicemotion', onDeviceMotion);
    return true;
  }
  function collectStill(ms) {
    return new Promise((resolve) => {
      const samples = [];
      const fn = (s) => samples.push(s);
      motion.listeners.add(fn);
      setTimeout(() => {
        motion.listeners.delete(fn);
        resolve(samples);
      }, ms);
    });
  }

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (_) {
      if (on) toast('Could not keep the screen on. Set screen timeout to 10 minutes or more.', 5000);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session && !session.ended) keepAwake(true);
  });

  /* ------------------------------------------------------- Map services */

  async function fetchJson(url, timeoutMs = 9000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Map service answered ${res.status}. Try again in a minute.`);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Map service did not answer. Check your signal and try again.');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  function searchPlaces(q, near) {
    const p = new URLSearchParams({ q, format: 'jsonv2', limit: '5', addressdetails: '0' });
    if (near) {
      const d = 0.6; // ~60 km box to prefer nearby results without excluding others
      p.set('viewbox', [near.lon - d, near.lat + d, near.lon + d, near.lat - d].join(','));
    }
    return fetchJson(`https://nominatim.openstreetmap.org/search?${p}`);
  }
  async function fetchRoute(from, to) {
    const url =
      `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
      '?overview=full&geometries=geojson&steps=true';
    return E.buildRoute(await fetchJson(url, 12000));
  }

  /* ------------------------------------------------------------- Session */

  let session = null;

  function makeSession({ condition, route, motionProc, demo }) {
    return {
      id: `r${Date.now().toString(36)}`,
      condition,
      demo: !!demo,
      route,
      tracker: route ? new E.RouteTracker(route, { leadSec: store.settings.leadSec }) : null,
      motionProc,
      forwardCheck: new E.ForwardCheck(),
      scenery: null,
      startedAt: Date.now(),
      ratings: [],
      cues: [],
      timers: [],
      flipped: false,
      fixes: 0,
      lastFixAt: 0,
      lastMotion: null,
      ended: false,
      promptOpen: false,
      promptOpenedAt: 0,
    };
  }

  const cuesVisible = () => session && session.condition === 'cues';

  function logCue(kind, detail) {
    session.cues.push({ t: Date.now() - session.startedAt, kind, ...detail, shown: cuesVisible() });
  }

  function handleFix(fix) {
    if (!session || session.ended || !fix) return;
    session.fixes += 1;
    session.lastFixAt = Date.now();
    updateRideGps(fix);
    if (session.scenery) {
      let speed = fix.speed;
      const prev = session.prevFix;
      if (!Number.isFinite(speed) && prev && fix.t > prev.t) {
        const dt = (fix.t - prev.t) / 1000;
        if (dt >= 0.3 && dt <= 4) speed = E.haversine(prev, fix) / dt;
      }
      session.scenery.gps({ speed, accuracy: fix.accuracy, fixT: fix.t, now: performance.now() });
    }
    session.prevFix = fix;
    if (session.motionProc && session.lastMotion && !session.flipped) {
      if (session.forwardCheck.add(fix.speed, fix.t, session.lastMotion.long)) {
        session.motionProc.reverse();
        session.flipped = true;
        logCue('mountReversed', {});
      }
    }
    if (!session.tracker) return;
    const res = session.tracker.update(fix, session.demo ? fix.t : Date.now());
    const scale = session.demo ? 1 / DEMO_SPEEDUP : 1;
    for (const ev of res.events) {
      if (ev.kind === 'offRoute') {
        $('#ride-note').textContent = 'Off the planned route. Turn cues paused; movement cues still work.';
        logCue('offRoute', {});
      } else if (ev.kind === 'backOnRoute') {
        $('#ride-note').textContent = '';
        logCue('backOnRoute', {});
      } else if (ev.kind === 'turn') {
        const timer = setTimeout(() => {
          if (!session || session.ended) return;
          logCue('turn', { dir: ev.dir, level: ev.level, label: ev.label });
          if (cuesVisible()) {
            showTurn(ev);
            buzz(ev.dir, ev.level);
          }
        }, ev.fireInMs * scale);
        session.timers.push(timer);
      }
    }
    $('#ride-next').textContent =
      res.offRoute || !res.next ? '' : `Next: ${res.next.label.toLowerCase()} in ${res.next.distance} m`;
    if (!cuesVisible()) $('#ride-next').textContent = '';
    renderDebug(fix, res);
  }

  let motionPeak = { long: 0, lat: 0 };
  function handleMotion(sample, t, rot) {
    if (!session || session.ended || !session.motionProc) return;
    const out = session.motionProc.push(sample, t, rot);
    if (!out) return;
    session.lastMotion = out;
    motionPeak.long = Math.max(motionPeak.long, Math.abs(out.long));
    motionPeak.lat = Math.max(motionPeak.lat, Math.abs(out.lat));
    if (session.scenery) session.scenery.motion(out.fast, t);
  }

  function updateRideGps(fix) {
    const good = fix.accuracy <= 25;
    $('#ride-gps-dot').className = `dot ${good ? 'ok' : 'wait'}`;
    $('#ride-gps-text').textContent = good ? 'GPS good' : `GPS ±${Math.round(fix.accuracy)} m`;
  }

  function renderDebug(fix, res) {
    const el = $('#debug');
    el.hidden = !store.settings.debug;
    if (el.hidden) return;
    const m = session.lastMotion;
    el.textContent = [
      `speed  ${fix.speed === null ? '–' : (fix.speed * 3.6).toFixed(0)} km/h`,
      `gps    ±${Math.round(fix.accuracy)} m`,
      `along  ${res ? Math.round(res.s) : '–'} m`,
      `next   ${res && res.next ? res.next.distance + ' m' : '–'}`,
      `long   ${m ? m.long.toFixed(2) : '–'} m/s²`,
      `lat    ${m ? m.lat.toFixed(2) : '–'} m/s²`,
      `flip   ${session.flipped ? 'yes' : 'no'}`,
    ].join('\n');
  }

  /* -------------------------------------------------------- Check-ins */

  function buildScale() {
    const box = $('#scale');
    box.innerHTML = '';
    for (let v = 0; v <= 20; v++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = v;
      b.dataset.v = v;
      b.setAttribute('aria-label', `${v} out of 20`);
      box.appendChild(b);
    }
  }
  function openPrompt() {
    if (!session || session.ended || session.promptOpen) return;
    session.promptOpen = true;
    session.promptOpenedAt = Date.now();
    $('#rate').hidden = false;
    buzz('prompt');
  }
  function closePrompt() {
    if (!session) return;
    session.promptOpen = false;
    $('#rate').hidden = true;
  }
  $('#scale').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || !session) return;
    session.ratings.push({ t: Date.now() - session.startedAt, fms: Number(b.dataset.v) });
    closePrompt();
    if (session.finishing) finishRide();
  });
  $('#rate-skip').addEventListener('click', () => {
    if (session && session.finishing) finishRide();
    else closePrompt();
  });
  $('#rate-now').addEventListener('click', openPrompt);

  /* ------------------------------------------------------- Ride lifecycle */

  let clockTimer = null;
  let ratingTimer = null;
  let staleTimer = null;

  function beginRide() {
    show('ride');
    const pill = $('#ride-pill');
    pill.className = `pill ${session.condition}`;
    pill.textContent = session.demo ? 'Demo · cues on' : conditionLabel(session.condition);
    $('#ride-note').textContent = session.motionProc ? '' : 'Movement cues off: no motion sensor.';
    if (!session.tracker && session.condition === 'cues') {
      $('#ride-note').textContent += session.motionProc ? 'No destination: movement cues only.' : '';
    }
    $('#ride').classList.toggle('color-levels', !!store.settings.colorLevels);
    if (session.motionProc && cuesVisible() && store.settings.motionCues) {
      session.scenery = new E.SceneryModel();
      startScenery();
    }
    keepAwake(true);
    gps.listeners.add(handleFix);
    motion.listeners.add(handleMotion);
    motionPeak = { long: 0, lat: 0 };

    clockTimer = setInterval(() => {
      $('#ride-clock').textContent = fmtClock(Date.now() - session.startedAt);
    }, 500);
    const every = session.demo ? 15000 : store.settings.ratingEveryMin * 60000;
    ratingTimer = setInterval(openPrompt, every);
    staleTimer = setInterval(() => {
      // Unanswered prompts close after 45 s so they do not pile up.
      if (session.promptOpen && Date.now() - session.promptOpenedAt > 45000) {
        closePrompt();
        if (session.finishing) return finishRide();
      }
      if (!session.demo && Date.now() - session.lastFixAt > 10000) {
        $('#ride-gps-dot').className = 'dot bad';
        $('#ride-gps-text').textContent = 'No GPS';
      }
    }, 1000);
    setTimeout(openPrompt, 600); // baseline rating
  }

  function stopRideIo() {
    session.ended = true;
    clearInterval(clockTimer);
    clearInterval(ratingTimer);
    clearInterval(staleTimer);
    session.timers.forEach(clearTimeout);
    if (session.demoTimer) clearInterval(session.demoTimer);
    gps.listeners.delete(handleFix);
    motion.listeners.delete(handleMotion);
    keepAwake(false);
    stopScenery();
    closePrompt();
  }

  $('#end-ride').addEventListener('click', (e) => {
    confirmTap(e.currentTarget, 'Tap again to end', () => {
      session.finishing = true;
      // Final check-in unless one was given in the last minute.
      const last = session.ratings[session.ratings.length - 1];
      if (!last || Date.now() - session.startedAt - last.t > 60000) openPrompt();
      else finishRide();
    });
  });

  function finishRide() {
    stopRideIo();
    session.endedAt = Date.now();
    if (session.demo) {
      const shown = session.cues.filter((c) => c.kind === 'turn').length;
      toast(`Demo finished: ${shown} turn cues fired. Nothing was saved.`, 5000);
      session = null;
      show('home');
      return;
    }
    const mins = (session.endedAt - session.startedAt) / 60000;
    $('#end-summary').textContent =
      `${conditionLabel(session.condition)} · ${mins.toFixed(0)} min · ${session.ratings.length} check-ins` +
      (mins < E.MIN_RIDE_MINUTES ? ` · rides under ${E.MIN_RIDE_MINUTES} minutes are kept but not counted in results.` : '');
    $('#end-form').reset();
    show('end');
  }

  $('#end-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    store.rides.push({
      id: session.id,
      condition: session.condition,
      demo: false,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      ratings: session.ratings,
      cues: session.cues,
      details: {
        seat: f.get('seat'),
        activity: f.get('activity'),
        road: f.get('road'),
        stoppedEarly: f.get('stoppedEarly') === 'yes',
        notes: String(f.get('notes') || '').slice(0, 500),
      },
      setup: {
        leadSec: store.settings.leadSec,
        mount: store.settings.mount,
        motionCues: store.settings.motionCues,
        colorLevels: store.settings.colorLevels,
        vibrate: store.settings.vibrate,
        hadRoute: !!session.route,
        routeKm: session.route ? Math.round(session.route.length / 100) / 10 : null,
        motionSensor: !!session.motionProc,
        mountReversed: session.flipped,
        gpsFixes: session.fixes,
        peakLongMs2: Math.round(motionPeak.long * 10) / 10,
        peakLatMs2: Math.round(motionPeak.lat * 10) / 10,
      },
    });
    session = null;
    if (store.save()) toast('Ride saved.');
    show('results');
  });
  $('#discard-ride').addEventListener('click', (e) => {
    confirmTap(e.currentTarget, 'Tap again to discard', () => {
      session = null;
      toast('Ride discarded.');
      show('home');
    });
  });

  /* ------------------------------------------------------------- Setup */

  const setup = { route: null, routeChosen: false, origin: null };

  function setupGpsListener(fix, err) {
    if (err) return setGpsStatus('bad', err);
    setup.origin = fix;
    const good = fix.accuracy <= 30;
    setGpsStatus(good ? 'ok' : 'wait', good ? `Located (±${Math.round(fix.accuracy)} m)` : `Weak fix (±${Math.round(fix.accuracy)} m). Move near a window.`);
  }

  renderers.setup = () => {
    setup.route = null;
    setup.routeChosen = false;
    $('#dest-results').innerHTML = '';
    $('#route-summary').hidden = true;
    $('#setup-error').hidden = true;
    $('#start-no-motion').hidden = true;
    $(`#mount-${store.settings.mount}`).checked = true;
    const next = E.nextCondition(store.rides);
    $('#start-condition').innerHTML =
      next === 'cues'
        ? '<span class="pill cues">Cues on</span> This ride shows cues.'
        : '<span class="pill control">Cues off</span> Comparison ride: the app records but shows no cues. These rides are what prove whether cues work.';
    gps.listeners.add(setupGpsListener);
    if (gps.last) setupGpsListener(gps.last);
    startGps();
    refreshStart();
  };

  function refreshStart() {
    $('#start-ride').disabled = !setup.routeChosen;
  }

  $('#dest-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#dest').value.trim();
    if (!q) return;
    const btn = $('#dest-search');
    btn.disabled = true;
    btn.textContent = 'Searching…';
    const box = $('#dest-results');
    box.innerHTML = '';
    try {
      const places = await searchPlaces(q, setup.origin);
      if (!places.length) {
        box.innerHTML = '<p class="muted small">No places found. Try a fuller address.</p>';
      }
      for (const pl of places) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'result-btn';
        b.textContent = pl.display_name;
        b.addEventListener('click', () => chooseDestination({ lat: Number(pl.lat), lon: Number(pl.lon) }, pl.display_name));
        box.appendChild(b);
      }
    } catch (err) {
      box.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'small';
      p.style.color = 'var(--danger)';
      p.textContent = err.message;
      box.appendChild(p);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Search';
    }
  });

  async function chooseDestination(dest, name) {
    const sum = $('#route-summary');
    sum.hidden = false;
    if (!setup.origin) {
      sum.innerHTML = '<span class="dot bad"></span><span>Waiting for your location before planning the route.</span>';
      return;
    }
    sum.innerHTML = '<span class="dot wait"></span><span>Planning route…</span>';
    try {
      const route = await fetchRoute(setup.origin, dest);
      setup.route = route;
      setup.routeChosen = true;
      const turns = route.maneuvers.filter((m) => m.dir !== 'stop').length;
      sum.innerHTML = '';
      sum.append(Object.assign(document.createElement('span'), { className: 'dot ok' }));
      sum.append(
        Object.assign(document.createElement('span'), {
          textContent: `${(route.length / 1000).toFixed(1)} km to ${name.split(',')[0]} · ${turns} turns to cue`,
        })
      );
      $('#dest-results').innerHTML = '';
    } catch (err) {
      sum.innerHTML = '<span class="dot bad"></span>';
      sum.append(Object.assign(document.createElement('span'), { textContent: err.message }));
    }
    refreshStart();
  }

  $('#no-route').addEventListener('click', () => {
    setup.route = null;
    setup.routeChosen = true;
    const sum = $('#route-summary');
    sum.hidden = false;
    sum.innerHTML = '<span class="dot ok"></span><span>No destination. Movement cues only.</span>';
    $('#dest-results').innerHTML = '';
    refreshStart();
  });

  $$('input[name="mount"]').forEach((r) =>
    r.addEventListener('change', () => {
      store.settings.mount = r.value;
      store.save();
    })
  );

  async function startFromSetup(useMotion) {
    const err = $('#setup-error');
    err.hidden = true;
    const btn = $('#start-ride');
    btn.disabled = true;
    btn.textContent = 'Hold still…';
    let motionProc = null;
    try {
      if (useMotion) {
        const allowed = await startMotion();
        if (!allowed) throw new Error('Motion access was refused.');
        const samples = await collectStill(2000);
        if (!motion.seen || samples.length < 10) {
          throw new Error('This browser is not giving motion data. Use Chrome on Android, or start without movement cues.');
        }
        motionProc = new E.MotionProcessor({ mount: store.settings.mount });
        motionProc.calibrate(samples);
      }
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      $('#start-no-motion').hidden = false;
      btn.textContent = 'Start ride';
      refreshStart();
      return;
    }
    gps.listeners.delete(setupGpsListener);
    btn.textContent = 'Start ride';
    session = makeSession({ condition: E.nextCondition(store.rides), route: setup.route, motionProc });
    beginRide();
  }
  $('#start-ride').addEventListener('click', () => startFromSetup(true));
  $('#start-no-motion').addEventListener('click', () => startFromSetup(false));

  /* -------------------------------------------------------------- Demo */

  const DEMO_SPEEDUP = 2;
  function startDemo() {
    const { osrm, timeline } = E.demoDrive();
    const route = E.buildRoute(osrm);
    // A virtual phone lying flat, so the demo exercises the same motion code as a real ride.
    const motionProc = new E.MotionProcessor({ mount: 'flat' });
    const G = 9.80665;
    motionProc.calibrate(Array.from({ length: 20 }, () => [0, 0, G]));
    session = makeSession({ condition: 'cues', route, motionProc, demo: true });
    session.lastFixAt = Date.now();
    beginRide();

    let i = 0;
    let simT = 0;
    const tickMs = 40; // 25 Hz motion samples in real time
    session.demoTimer = setInterval(() => {
      if (!session || session.ended) return;
      simT += tickMs * DEMO_SPEEDUP;
      // Ease between per-second samples so the simulated push rises and falls smoothly
      // instead of jumping, then convert car-frame acceleration to what a flat phone reads
      // (left = -x, forward = +y).
      const cur = timeline[Math.min(i, timeline.length - 1)];
      const prev = timeline[Math.max(0, i - 1)];
      const span = Math.max(1, cur.t - prev.t);
      const f = Math.max(0, Math.min(1, 1 - (cur.t - simT) / span));
      const ease = f * f * (3 - 2 * f);
      const long = prev.long + (cur.long - prev.long) * ease;
      const lat = prev.lat + (cur.lat - prev.lat) * ease;
      // A flat phone's "up" is +z, so the gyroscope's turn rate is alpha (3rd entry).
      const yawDeg = (lat / 12) * (180 / Math.PI); // demo speed is 12 m/s
      handleMotion([-lat, long, G], performance.now(), [0, 0, yawDeg]);
      if (simT >= timeline[Math.min(i, timeline.length - 1)].t) {
        if (i < timeline.length) {
          session.lastFixAt = Date.now();
          handleFix({ ...timeline[i].fix, t: timeline[i].t });
          i += 1;
        } else {
          finishRide();
        }
      }
    }, tickMs);
  }
  $('#go-demo').addEventListener('click', () => {
    if (!store.settings.safetyAck) return show('safety');
    startDemo();
  });

  /* ----------------------------------------------------------- Home */

  renderers.home = () => {
    const real = store.rides.filter((r) => !r.demo);
    const usable = real.map(E.summarizeRide).filter((s) => s.usable);
    $('#home-cues').textContent = usable.filter((s) => s.condition === 'cues').length;
    $('#home-control').textContent = usable.filter((s) => s.condition === 'control').length;
    $('#home-goal').textContent = E.MIN_RIDES_PER_ARM;
    const next = E.nextCondition(store.rides);
    const pill = $('#next-pill');
    pill.className = `pill ${next}`;
    pill.textContent = conditionLabel(next);
    $('#next-explain').textContent =
      next === 'cues'
        ? 'You will see and feel cues before turns and during braking.'
        : 'Comparison ride: the app records your check-ins but shows no cues. Without these rides there is nothing to compare against.';
  };
  $('#go-setup').addEventListener('click', () => show(store.settings.safetyAck ? 'setup' : 'safety'));
  $('#go-results').addEventListener('click', () => show('results'));
  $('#go-settings').addEventListener('click', () => show('settings'));
  $('#ack-safety').addEventListener('click', () => {
    store.settings.safetyAck = true;
    store.save();
    show('setup');
  });

  /* --------------------------------------------------------- Results */

  function plotSvg(rides) {
    const sums = rides.map(E.summarizeRide).filter((s) => s.usable);
    if (!sums.length) return '<p class="muted small">Your rides will appear here.</p>';
    const W = 320;
    const H = 120;
    const left = 70;
    const right = 12;
    const x = (v) => left + (v / 20) * (W - left - right);
    const rowY = { cues: 34, control: 78 };
    let marks = '';
    for (const s of sums) {
      const color = s.condition === 'cues' ? 'var(--cue)' : 'var(--control)';
      marks += `<circle cx="${x(s.peak).toFixed(1)}" cy="${rowY[s.condition]}" r="6" fill="${color}" fill-opacity="0.75"/>`;
    }
    let ticks = '';
    for (const v of [0, 5, 10, 15, 20]) {
      ticks += `<line x1="${x(v)}" x2="${x(v)}" y1="18" y2="94" stroke="var(--line)"/>`;
      ticks += `<text x="${x(v)}" y="112" text-anchor="middle">${v}</text>`;
    }
    return (
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Peak sickness per ride, cues on versus off">` +
      ticks +
      `<text x="0" y="${rowY.cues + 4}">Cues on</text><text x="0" y="${rowY.control + 4}">Cues off</text>` +
      marks +
      '</svg>'
    );
  }

  renderers.results = () => {
    const real = store.rides.filter((r) => !r.demo);
    const c = E.compare(real);
    const v = $('#verdict');
    v.className = `verdict ${c.verdict}`;
    $('#verdict-title').textContent = {
      collecting: 'Still collecting',
      helped: 'Cues helped',
      'no-benefit': 'No benefit so far',
      unclear: 'Not clear yet',
    }[c.verdict];
    $('#verdict-text').textContent = c.message;
    $('#r-peak-cues').textContent = fmt1(c.peak.cues);
    $('#r-peak-control').textContent = fmt1(c.peak.control);
    $('#r-diff').textContent =
      c.peak.cues !== null && c.peak.control !== null ? fmt1(c.peak.control - c.peak.cues) : '–';
    $('#plot').innerHTML = plotSvg(real);

    const list = $('#ride-list');
    list.innerHTML = '';
    if (!real.length) list.innerHTML = '<p class="muted small">No rides yet.</p>';
    real
      .slice()
      .reverse()
      .forEach((r) => {
        const s = E.summarizeRide(r);
        const item = document.createElement('div');
        item.className = 'ride-item';
        const info = document.createElement('div');
        info.innerHTML =
          `<span class="pill ${r.condition}">${conditionLabel(r.condition)}</span> ` +
          `<span class="small">${new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>` +
          `<div class="small muted">${s.minutes.toFixed(0)} min · peak ${s.peak ?? '–'} · ${s.ratings} check-ins${s.usable ? '' : ' · not counted'}</div>`;
        const del = document.createElement('button');
        del.className = 'ghost danger small';
        del.textContent = 'Delete';
        del.addEventListener('click', () =>
          confirmTap(del, 'Confirm', () => {
            store.rides = store.rides.filter((x) => x.id !== r.id);
            store.save();
            renderers.results();
          })
        );
        item.append(info, del);
        list.appendChild(item);
      });
  };

  function summaryText() {
    const real = store.rides.filter((r) => !r.demo);
    const c = E.compare(real);
    const lines = [
      'Andar motion sickness trial',
      `Usable rides: ${c.counts.cues} with cues, ${c.counts.control} without (${c.counts.excluded} not counted)`,
      `Average peak sickness (0-20): cues ${fmt1(c.peak.cues)}, without ${fmt1(c.peak.control)}`,
      `Average sickness (0-20): cues ${fmt1(c.mean.cues)}, without ${fmt1(c.mean.control)}`,
      c.p !== null ? `One-sided permutation test on peak: p = ${c.p.toFixed(3)}` : '',
      `Verdict: ${c.message}`,
      `Settings: warn ${store.settings.leadSec}s before turns, mount ${store.settings.mount}`,
    ];
    return lines.filter(Boolean).join('\n');
  }

  $('#copy-summary').addEventListener('click', async () => {
    const text = summaryText();
    try {
      await navigator.clipboard.writeText(text);
      toast('Summary copied.');
    } catch (_) {
      toast('Copy was blocked. Use Download instead.');
    }
  });

  function download(name, mime, text) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  function ridesCsv() {
    const head = [
      'ride_id', 'started', 'condition', 'minutes', 'peak_fms', 'mean_fms', 'checkins', 'counted',
      'seat', 'activity', 'road', 'stopped_early', 'had_route', 'turn_cues', 'lead_sec', 'mount',
      'peak_long_ms2', 'peak_lat_ms2', 'notes',
    ];
    const rows = store.rides
      .filter((r) => !r.demo)
      .map((r) => {
        const s = E.summarizeRide(r);
        const d = r.details || {};
        const u = r.setup || {};
        return [
          r.id, new Date(r.startedAt).toISOString(), r.condition, s.minutes.toFixed(1), s.peak,
          s.mean === null ? '' : s.mean.toFixed(2), s.ratings, s.usable ? 'yes' : 'no',
          d.seat, d.activity, d.road, d.stoppedEarly ? 'yes' : 'no', u.hadRoute ? 'yes' : 'no',
          (r.cues || []).filter((c) => c.kind === 'turn').length, u.leadSec, u.mount,
          u.peakLongMs2, u.peakLatMs2, d.notes,
        ].map(csvCell).join(',');
      });
    return [head.join(','), ...rows].join('\n');
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  $('#dl-csv').addEventListener('click', () => download(`andar-rides-${stamp()}.csv`, 'text/csv', ridesCsv()));
  $('#dl-json').addEventListener('click', () =>
    download(`andar-data-${stamp()}.json`, 'application/json', JSON.stringify({ version: 1, ...store }, null, 2))
  );

  /* -------------------------------------------------------- Settings */

  renderers.settings = () => {
    const s = store.settings;
    $('#lead').value = s.leadSec;
    $('#lead-val').textContent = `${s.leadSec} s`;
    $('#interval').value = String(s.ratingEveryMin);
    $('#opt-vibrate').checked = s.vibrate;
    $('#opt-motion').checked = s.motionCues;
    $('#opt-color').checked = s.colorLevels;
    $('#opt-debug').checked = s.debug;
    $('#data-count').textContent = `${store.rides.length} rides stored on this phone.`;
  };
  $('#lead').addEventListener('input', (e) => {
    store.settings.leadSec = Number(e.target.value);
    $('#lead-val').textContent = `${store.settings.leadSec} s`;
    store.save();
  });
  $('#interval').addEventListener('change', (e) => {
    store.settings.ratingEveryMin = Number(e.target.value);
    store.save();
  });
  [['#opt-vibrate', 'vibrate'], ['#opt-motion', 'motionCues'], ['#opt-color', 'colorLevels'], ['#opt-debug', 'debug']].forEach(([sel, key]) =>
    $(sel).addEventListener('change', (e) => {
      store.settings[key] = e.target.checked;
      store.save();
    })
  );
  $('#clear-all').addEventListener('click', (e) =>
    confirmTap(e.currentTarget, 'Tap again to delete everything', () => {
      store.rides = [];
      store.save();
      renderers.settings();
      toast('All rides deleted.');
    })
  );

  /* ------------------------------------------------------------ Boot */

  store.load();
  buildScale();
  show('home');
  // Test hook: lets the automated browser test drive the demo without waiting in real time.
  window.__andar = { store, get session() { return session; }, E, hapticPattern };
})();
