import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const REGION_COLORS = { americas: '#e77fa6', eurafrica: '#f2c35b', asiapac: '#7fd6c9' };
const WEEKS_PER_SECOND = 2.6;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const els = {
  list: $('species-list'), globe: $('globe'), labels: $('labels'),
  name: $('detail-name'), sci: $('detail-sci'), blurb: $('detail-blurb'),
  regions: $('detail-regions'), status: $('status'), message: $('message'),
  play: $('play'), weekLabel: $('week-label'), today: $('today'), track: $('track'),
  about: $('about'), aboutOpen: $('about-open'), aboutYear: $('about-year'),
};

const state = {
  manifest: null,
  species: null,      // current manifest entry
  paths: [],          // regional paths for current species
  frames: [],         // Image per week (or undefined while loading)
  week: 0,            // fractional week index 0..52
  todayWeek: 0,
  playing: false,
  loadToken: 0,
  drawnWeek: -1,
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function toVec(lat, lon, r = 1) {
  const la = THREE.MathUtils.degToRad(lat);
  const lo = THREE.MathUtils.degToRad(lon);
  // Matches THREE.SphereGeometry's UV layout for an equirectangular texture.
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

function slerpVec(a, b, t) {
  const angle = a.angleTo(b);
  if (angle < 1e-6) return a.clone();
  const s = Math.sin(angle);
  return a.clone().multiplyScalar(Math.sin((1 - t) * angle) / s).add(b.clone().multiplyScalar(Math.sin(t * angle) / s));
}

function wrapWeek(w) { return ((w % 52) + 52) % 52; }

/** Position of a regional population at a fractional week, or null if absent. */
function positionAt(points, w) {
  const i = Math.floor(wrapWeek(w));
  const j = (i + 1) % 52;
  const t = wrapWeek(w) - i;
  const a = points[i], b = points[j];
  if (a && b) return slerpVec(toVec(a[0], a[1]), toVec(b[0], b[1]), t);
  if (a && t < 0.5) return toVec(a[0], a[1]);
  if (b && t >= 0.5) return toVec(b[0], b[1]);
  return null;
}

/** Contiguous runs of weeks with a position, joined across the new year. */
function runsOf(points) {
  const present = points.map((p) => !!p);
  if (present.every(Boolean)) return [{ start: 0, len: 52, loop: true }];
  const runs = [];
  let start = present.findIndex((p, i) => p && !present[(i + 51) % 52]);
  if (start < 0) return runs;
  for (let k = 0; k < 52; k++) {
    const i = (start + k) % 52;
    if (present[i] && !present[(i + 51) % 52]) {
      let len = 0;
      while (len < 52 && present[(i + len) % 52]) len++;
      runs.push({ start: i, len, loop: false });
    }
  }
  return runs;
}

function densify(points, start, len, loop, r) {
  const out = [];
  const steps = 6;
  const n = loop ? len : len - 1;
  for (let k = 0; k < n; k++) {
    const a = points[(start + k) % 52], b = points[(start + k + 1) % 52];
    const va = toVec(a[0], a[1]), vb = toVec(b[0], b[1]);
    for (let s = 0; s < steps; s++) out.push(slerpVec(va, vb, s / steps).multiplyScalar(r));
  }
  const last = points[(start + (loop ? 0 : len - 1)) % 52];
  out.push(toVec(last[0], last[1], r));
  return out;
}

// ---------------------------------------------------------------------------
// Globe
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
els.globe.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
camera.position.copy(toVec(30, -20, 4));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.6;
controls.minDistance = 1.5;
controls.maxDistance = 8;

const loader = new THREE.TextureLoader();
const baseTex = loader.load('assets/earth.jpg');
baseTex.colorSpace = THREE.SRGBColorSpace;
baseTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
const sphereGeo = new THREE.SphereGeometry(1, 128, 64);
scene.add(new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ map: baseTex })));

// Abundance overlay: one canvas, redrawn when the week changes.
const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 600;
const overlayCanvas = document.createElement('canvas');
overlayCanvas.width = smallScreen ? 1024 : 1440;
overlayCanvas.height = overlayCanvas.width / 2;
const octx = overlayCanvas.getContext('2d');
const overlayTex = new THREE.CanvasTexture(overlayCanvas);
overlayTex.colorSpace = THREE.SRGBColorSpace;
overlayTex.anisotropy = baseTex.anisotropy;
const overlay = new THREE.Mesh(
  new THREE.SphereGeometry(1.0015, 128, 64),
  new THREE.MeshBasicMaterial({ map: overlayTex, transparent: true, depthWrite: false })
);
scene.add(overlay);

// Soft atmosphere rim.
scene.add(new THREE.Mesh(
  new THREE.SphereGeometry(1.14, 64, 32),
  new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color('#5d6fd6') } },
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 color; varying vec3 vN; void main(){ float i = 0.75 * pow(max(0.0, 0.62 - dot(vN, vec3(0,0,1.0))), 2.8); gl_FragColor = vec4(color, 1.0) * i; }',
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  })
));

const pathGroup = new THREE.Group();
const trailGroup = new THREE.Group();
const markerGroup = new THREE.Group();
scene.add(pathGroup, trailGroup, markerGroup);
let markers = []; // {region, mesh, halo, label}

function clearGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    c.geometry?.dispose();
    c.material?.dispose();
  }
}

function buildPaths() {
  clearGroup(pathGroup);
  clearGroup(markerGroup);
  els.labels.replaceChildren();
  markers = [];
  for (const p of state.paths) {
    const color = new THREE.Color(REGION_COLORS[p.region] || '#ffffff');
    for (const run of runsOf(p.points)) {
      if (run.len < 2) continue;
      const pts = densify(p.points, run.start, run.len, run.loop, 1.006);
      const curve = new THREE.CatmullRomCurve3(pts, run.loop);
      const geo = new THREE.TubeGeometry(curve, pts.length * 2, 0.0028, 6, run.loop);
      pathGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, depthWrite: false })));
    }
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.016, 20, 12), new THREE.MeshBasicMaterial({ color }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.034, 20, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }));
    markerGroup.add(mesh, halo);
    const label = document.createElement('div');
    label.className = 'region-label';
    label.innerHTML = `<span></span><small></small>`;
    label.firstChild.textContent = p.name;
    els.labels.appendChild(label);
    markers.push({ path: p, color, mesh, halo, label });
  }
}

let lastTrailWeek = -1;
function updateMarkers() {
  const w = state.week;
  const rebuildTrail = Math.abs(w - lastTrailWeek) > 0.04;
  if (rebuildTrail) { clearGroup(trailGroup); lastTrailWeek = w; }
  for (const m of markers) {
    const pos = positionAt(m.path.points, w);
    m.visible = !!pos;
    m.mesh.visible = m.halo.visible = !!pos;
    if (!pos) continue;
    m.mesh.position.copy(pos).multiplyScalar(1.008);
    m.halo.position.copy(m.mesh.position);
    m.pos = pos;
    m.lat = THREE.MathUtils.radToDeg(Math.asin(pos.y));
    if (rebuildTrail) {
      // Brighter trail over the last five weeks.
      const pts = [];
      for (let k = 0; k <= 30; k++) {
        const v = positionAt(m.path.points, w - 5 + (5 * k) / 30);
        if (v) pts.push(v.multiplyScalar(1.007));
      }
      if (pts.length > 3) {
        const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.0048, 6, false);
        trailGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.95, depthWrite: false })));
      }
    }
  }
}

const tmp = new THREE.Vector3();
function updateLabels() {
  const rect = els.globe.getBoundingClientRect();
  const camDir = camera.position.clone().normalize();
  for (const m of markers) {
    if (!m.visible) { m.label.style.opacity = 0; continue; }
    const facing = m.pos.dot(camDir);
    tmp.copy(m.mesh.position).project(camera);
    const x = (tmp.x * 0.5 + 0.5) * rect.width;
    const y = (-tmp.y * 0.5 + 0.5) * rect.height;
    m.label.style.transform = `translate(${x.toFixed(1)}px, ${(y - 14).toFixed(1)}px)`;
    m.label.style.opacity = facing > 0.25 ? 1 : 0;
    const lat = Math.round(m.lat);
    m.label.lastChild.textContent = lat === 0 ? 'On the equator' : `Centred near ${Math.abs(lat)}° ${lat > 0 ? 'N' : 'S'}`;
  }
}

function drawOverlay() {
  const w = wrapWeek(state.week);
  const i = Math.floor(w), j = (i + 1) % 52, t = reduceMotion ? 0 : w - i;
  const key = `${i}:${t.toFixed(2)}:${!!state.frames[i]}:${!!state.frames[j]}`;
  if (key === state.drawnKey) return;
  state.drawnKey = key;
  const { width, height } = overlayCanvas;
  octx.clearRect(0, 0, width, height);
  const a = state.frames[i], b = state.frames[j];
  if (a) { octx.globalAlpha = b ? 1 - t : 1; octx.drawImage(a, 0, 0, width, height); }
  if (b && t > 0) { octx.globalAlpha = t; octx.drawImage(b, 0, 0, width, height); }
  octx.globalAlpha = 1;
  overlayTex.needsUpdate = true;
}

function fitCamera() {
  const rect = els.globe.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  camera.aspect = rect.width / Math.max(1, rect.height);
  camera.updateProjectionMatrix();
  const fill = 0.78;
  const d = 1 / (fill * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect));
  camera.position.setLength(d);
  controls.maxDistance = Math.max(d * 1.6, 4);
  drawTrack();
}

let flight = null;
function flyTo(lat, lon) {
  const end = toVec(lat, lon, camera.position.length());
  if (reduceMotion) { camera.position.copy(end); return; }
  flight = { from: camera.position.clone(), to: end, t0: performance.now(), dur: 900 };
}

let lastFrame = performance.now();
function animate(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (state.playing) {
    if (reduceMotion) {
      state.stepAcc = (state.stepAcc || 0) + dt;
      if (state.stepAcc > 0.45) { state.stepAcc = 0; setWeek(Math.floor(state.week) + 1); }
    } else {
      setWeek(state.week + dt * WEEKS_PER_SECOND);
    }
  }
  if (flight) {
    const k = Math.min(1, (now - flight.t0) / flight.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.copy(slerpVec(flight.from.clone().normalize(), flight.to.clone().normalize(), e)
      .multiplyScalar(THREE.MathUtils.lerp(flight.from.length(), flight.to.length(), e)));
    if (k >= 1) flight = null;
  }
  controls.update();
  drawOverlay();
  updateMarkers();
  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });

function weekDate(i) {
  const s = state.manifest.weeks[wrapWeek(Math.round(i)) % state.manifest.weeks.length];
  return new Date(`${s}T12:00:00Z`);
}

function weekText(i) {
  return `Week of ${dateFmt.format(weekDate(i))}`;
}

function findTodayWeek() {
  const now = new Date();
  const doy = (d) => (Date.UTC(2023, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2023, 0, 1)) / 864e5;
  const today = (Date.UTC(2023, now.getMonth(), now.getDate()) - Date.UTC(2023, 0, 1)) / 864e5;
  let best = 0, bestDiff = Infinity;
  state.manifest.weeks.forEach((s, i) => {
    const d = Math.abs(doy(new Date(`${s}T12:00:00Z`)) + 3 - today); // week centre
    const diff = Math.min(d, 365 - d);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  return best;
}

function setWeek(w, { fromUser = false } = {}) {
  state.week = wrapWeek(w);
  const i = Math.round(state.week) % 52;
  if (i !== state.labelWeek) {
    state.labelWeek = i;
    els.weekLabel.textContent = weekText(i);
    els.track.setAttribute('aria-valuenow', String(i + 1));
    els.track.setAttribute('aria-valuetext', weekText(i));
  }
  moveCursor();
  if (fromUser) updateHash();
}

function setPlaying(on) {
  state.playing = on;
  els.play.setAttribute('aria-pressed', String(on));
  els.play.setAttribute('aria-label', on ? 'Pause' : 'Play the year');
  if (!on) { setWeek(Math.round(state.week)); updateHash(); }
}

// ---------------------------------------------------------------------------
// Timeline: latitude bands per population, with a draggable cursor
// ---------------------------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
let trackScale = null;

function drawTrack() {
  const svg = els.track;
  if (!state.manifest) return;
  const W = svg.clientWidth || 600;
  const H = svg.clientHeight || 110;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const m = { l: 44, r: 10, t: 16, b: 18 };
  const x = (w) => m.l + (w / 51) * (W - m.l - m.r);

  let lats = state.paths.flatMap((p) => p.points.filter(Boolean).map((q) => q[0]));
  if (!lats.length) lats = [-30, 60];
  let lo = Math.min(...lats) - 10, hi = Math.max(...lats) + 10;
  if (hi - lo < 40) { const c = (hi + lo) / 2; lo = c - 20; hi = c + 20; }
  lo = Math.max(-85, lo); hi = Math.min(85, hi);
  const y = (lat) => m.t + ((hi - lat) / (hi - lo)) * (H - m.t - m.b);
  trackScale = { x, m, W, H };

  // Latitude guides.
  for (let lat = -60; lat <= 80; lat += 30) {
    if (lat < lo || lat > hi) continue;
    svgEl('line', { x1: m.l, x2: W - m.r, y1: y(lat), y2: y(lat), class: lat === 0 ? 'equator' : 'grid', opacity: lat === 0 ? 1 : 0.5 }, svg);
    const t = svgEl('text', { x: m.l - 8, y: y(lat) + 4, 'text-anchor': 'end', class: 'axis' }, svg);
    t.textContent = lat === 0 ? '0°' : `${Math.abs(lat)}° ${lat > 0 ? 'N' : 'S'}`;
  }

  // Month labels.
  let lastMonth = -1;
  const everyOther = (W - m.l - m.r) / 12 < 34; // too narrow for all twelve labels
  state.manifest.weeks.forEach((s, i) => {
    const d = new Date(`${s}T12:00:00Z`);
    if (d.getUTCMonth() !== lastMonth) {
      lastMonth = d.getUTCMonth();
      if (everyOther && lastMonth % 2) return;
      const t = svgEl('text', { x: x(i), y: H - 3, class: 'month' }, svg);
      t.textContent = monthFmt.format(d);
    }
  });

  // Population bands: centre line follows latitude, width follows how many birds.
  const maxHalf = Math.max(5, (H - m.t - m.b) * 0.1);
  for (const p of state.paths) {
    const color = REGION_COLORS[p.region] || '#ffffff';
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const top = run.map((r) => `${x(r.i).toFixed(1)},${(y(r.lat) - r.h).toFixed(1)}`);
        const bot = run.slice().reverse().map((r) => `${x(r.i).toFixed(1)},${(y(r.lat) + r.h).toFixed(1)}`);
        svgEl('polygon', { points: [...top, ...bot].join(' '), fill: color, 'fill-opacity': 0.42 }, svg);
        svgEl('polyline', { points: run.map((r) => `${x(r.i).toFixed(1)},${y(r.lat).toFixed(1)}`).join(' '),
          fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, svg);
      }
      run = [];
    };
    p.points.forEach((q, i) => {
      if (!q) { flush(); return; }
      run.push({ i, lat: q[0], h: Math.max(0.75, (p.presence?.[i] ?? 1) * maxHalf) });
    });
    flush();
  }

  // Today marker.
  const tx = x(state.todayWeek);
  svgEl('path', { d: `M${tx - 5},2 L${tx + 5},2 L${tx},9 Z`, class: 'today-mark' }, svg);
  const tt = svgEl('text', { x: tx + 8, y: 10, class: 'today-text' }, svg);
  tt.textContent = 'Today';
  if (tx + 50 > W) { tt.setAttribute('x', tx - 8); tt.setAttribute('text-anchor', 'end'); }

  // Cursor.
  const g = svgEl('g', { id: 'cursor' }, svg);
  svgEl('line', { x1: 0, x2: 0, y1: m.t - 4, y2: H - m.b + 2, class: 'cursor' }, g);
  svgEl('circle', { cx: 0, cy: H - m.b + 2, r: 4.5, class: 'cursor-knob' }, g);
  moveCursor();
}

function moveCursor() {
  const g = els.track.querySelector('#cursor');
  if (g && trackScale) g.setAttribute('transform', `translate(${trackScale.x(Math.min(51, state.week)).toFixed(1)},0)`);
}

function weekFromPointer(ev) {
  const r = els.track.getBoundingClientRect();
  const { m, W } = trackScale;
  const px = ((ev.clientX - r.left) / r.width) * W;
  return Math.max(0, Math.min(51, ((px - m.l) / (W - m.l - m.r)) * 51));
}

els.track.addEventListener('pointerdown', (ev) => {
  if (!trackScale) return;
  els.track.setPointerCapture(ev.pointerId);
  setPlaying(false);
  setWeek(Math.round(weekFromPointer(ev)));
  const move = (e) => setWeek(Math.round(weekFromPointer(e)));
  const up = () => {
    els.track.removeEventListener('pointermove', move);
    els.track.removeEventListener('pointerup', up);
    els.track.removeEventListener('pointercancel', up);
    updateHash();
  };
  els.track.addEventListener('pointermove', move);
  els.track.addEventListener('pointerup', up);
  els.track.addEventListener('pointercancel', up);
});

els.track.addEventListener('keydown', (ev) => {
  const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 4, PageDown: -4 };
  let w = null;
  if (ev.key in steps) w = Math.round(state.week) + steps[ev.key];
  if (ev.key === 'Home') w = 0;
  if (ev.key === 'End') w = 51;
  if (w === null) return;
  ev.preventDefault();
  setPlaying(false);
  setWeek(w, { fromUser: true });
});

els.play.addEventListener('click', () => setPlaying(!state.playing));
els.today.addEventListener('click', () => { setPlaying(false); setWeek(state.todayWeek, { fromUser: true }); focusSpecies(); });
els.aboutOpen.addEventListener('click', () => els.about.showModal());

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------
function renderList() {
  els.list.replaceChildren();
  for (const sp of state.manifest.species) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.code = sp.code;
    const n = document.createElement('span'); n.className = 'name'; n.textContent = sp.common;
    const s = document.createElement('span'); s.className = 'sci'; s.textContent = sp.sci;
    b.append(n, s);
    b.addEventListener('click', () => selectSpecies(sp.code, { fromUser: true }));
    li.appendChild(b);
    els.list.appendChild(li);
  }
}

function focusSpecies() {
  const main = markers.find((m) => m.visible) || null;
  const p = main ? main.pos : null;
  if (p) {
    const lat = THREE.MathUtils.radToDeg(Math.asin(p.y));
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-p.z, p.x));
    flyTo(Math.max(-50, Math.min(55, lat * 0.8 + 8)), lon);
  }
}

async function selectSpecies(code, { fromUser = false } = {}) {
  const sp = state.manifest.species.find((s) => s.code === code) || state.manifest.species[0];
  state.species = sp;
  const token = ++state.loadToken;
  for (const b of els.list.querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.code === sp.code));
  els.name.textContent = sp.common;
  els.sci.textContent = sp.sci;
  els.blurb.textContent = sp.blurb;
  els.regions.replaceChildren();
  document.title = `${sp.common}, Flight tracks`;
  if (fromUser) updateHash();

  state.frames = new Array(52);
  state.drawnKey = null;
  state.paths = [];
  buildPaths();

  try {
    const res = await fetch(`data/species/${sp.code}/paths.json`);
    if (!res.ok) throw new Error(`paths ${res.status}`);
    const data = await res.json();
    if (token !== state.loadToken) return;
    state.paths = data.paths;
  } catch (e) {
    console.warn(e);
    state.paths = [];
  }
  buildPaths();
  lastTrailWeek = -1;
  updateMarkers();
  drawTrack();
  for (const p of state.paths) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = REGION_COLORS[p.region] || '#fff';
    li.append(sw, `${p.name}, ${Math.round(p.share * 100)}% of the year's birds`);
    els.regions.appendChild(li);
  }
  focusSpecies();
  loadFrames(sp, token);
}

function loadFrames(sp, token) {
  const start = Math.round(state.week) % 52;
  const order = [];
  for (let k = 0; k < 52; k++) order.push((start + (k % 2 ? Math.ceil(k / 2) : -k / 2) + 52) % 52);
  let done = 0, failed = 0;
  const total = sp.frames || 52;
  const update = () => {
    if (token !== state.loadToken) return;
    if (failed) els.status.textContent = `${failed} of ${total} weeks failed to load. Reload the page to try again.`;
    else els.status.textContent = done < total ? `Loading weeks, ${done} of ${total}` : '';
  };
  update();
  let next = 0;
  const worker = async () => {
    while (next < order.length) {
      const i = order[next++];
      if (i >= total) continue;
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = `data/species/${sp.code}/w${String(i).padStart(2, '0')}.png`;
        await img.decode();
        if (token !== state.loadToken) return;
        state.frames[i] = img;
        state.drawnKey = null;
        done++;
      } catch {
        failed++;
      }
      update();
    }
  };
  for (let k = 0; k < 6; k++) worker();
}

// ---------------------------------------------------------------------------
// URL state: #species/week
// ---------------------------------------------------------------------------
function updateHash() {
  if (!state.species) return;
  history.replaceState(null, '', `#${state.species.code}/${Math.round(state.week) % 52 + 1}`);
}

function readHash() {
  const [code, wk] = location.hash.replace(/^#/, '').split('/');
  const w = parseInt(wk, 10);
  return { code: code || null, week: Number.isFinite(w) && w >= 1 && w <= 52 ? w - 1 : null };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function showMessage(title, body) {
  els.message.hidden = false;
  els.message.innerHTML = '<h2></h2><p></p>';
  els.message.firstChild.textContent = title;
  els.message.lastChild.textContent = body;
  document.querySelector('.detail').hidden = true;
}

async function start() {
  new ResizeObserver(fitCamera).observe(els.globe);
  fitCamera();
  requestAnimationFrame(animate);

  let manifest;
  try {
    const res = await fetch('data/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    manifest = await res.json();
  } catch {
    showMessage('The map has no bird data yet',
      'The data is built by the "Build data and deploy" workflow on GitHub. Once it has run, species will appear here.');
    return;
  }
  if (!manifest.species?.length) {
    showMessage('No species were built',
      'The last data build finished without any species. Check the workflow log on GitHub for the reason.');
    return;
  }
  state.manifest = manifest;
  els.aboutYear.textContent = manifest.version_year;
  state.todayWeek = findTodayWeek();
  renderList();
  const h = readHash();
  setWeek(h.week ?? state.todayWeek);
  await selectSpecies(h.code || manifest.species[0].code);
  window.addEventListener('hashchange', () => {
    const k = readHash();
    if (k.week !== null) setWeek(k.week);
    if (k.code && k.code !== state.species?.code) selectSpecies(k.code);
  });
}

start();
