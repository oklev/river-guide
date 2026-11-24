import type { LatLng } from './types';

/** Everything a trip report page shows. Embedded in the page as JSON. */
export interface ReportItem {
  kind: 'start' | 'finish' | 'photo' | 'point';
  title: string;
  text: string;
  time?: number;
  mile?: number;
  at?: LatLng;
  /** Index into ReportData.photos. */
  photo?: number;
  category?: string;
  icon?: string;
  color?: string;
}

export interface ReportData {
  title: string;
  subtitle: string;
  date: number;
  stats: {
    distanceMi?: number;
    totalMs?: number;
    movingMs?: number;
    avgMph?: number;
    photos: number;
    points: number;
  };
  route: LatLng[];
  routeColor: string;
  /** Each GPS track: [lat, lng, time ms (0 if unknown)][] */
  tracks: [number, number, number][][];
  /** For each track, when it was on the water [start, end] (null: all of it). */
  water: ([number, number] | null)[];
  /** Which optional parts to show. */
  show: { stats: boolean; sun: boolean; speed: boolean; legend: boolean };
  items: ReportItem[];
  photos: { src: string; panorama: boolean }[];
  tiles: { url: string; maxNativeZoom: number; attribution: string };
  generated: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** JSON that is safe inside <script>: no "</script>" or "<!--" can appear. */
const scriptJson = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));

export async function reportHtml(data: ReportData): Promise<string> {
  // Leaflet is embedded so the report doesn't depend on a CDN (only tiles need internet).
  const [{ default: leafletJs }, { default: leafletCss }] = await Promise.all([
    import('leaflet/dist/leaflet.js?raw'),
    import('leaflet/dist/leaflet.css?raw'),
  ]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(data.title)} · Trip report</title>
<style>${leafletCss}</style>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <div id="date" class="muted"></div>
  <p id="subtitle"></p>
  <div id="stats" class="stats"></div>
</header>
<div class="layout">
  <div class="map-wrap"><div id="sun" class="sun" hidden></div><div id="map"></div></div>
  <ol id="timeline" class="timeline"></ol>
</div>
<footer class="muted">Made with River Guide · <span id="generated"></span></footer>
<div id="viewer" class="viewer" hidden><div class="viewer-scroll"><img id="viewer-img" alt="" /></div><div id="viewer-caption" class="viewer-caption"></div><button id="viewer-close" aria-label="Close">✕</button></div>
<script>${leafletJs.replace(/<\/script/gi, '<\\/script')}</script>
<script id="data" type="application/json">${scriptJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
:root { --bg: #fff; --fg: #1d2a30; --muted: #61727a; --border: #dbe3e6; --accent: #0f4c5c; --card: #f6f9fa; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #172227; --fg: #e4ecef; --muted: #93a5ad; --border: #2c3b41; --accent: #3fa7b8; --card: #1e2c32; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
header { padding: 20px 16px 8px; max-width: 1200px; margin: 0 auto; }
h1 { margin: 0; color: var(--accent); font-size: 1.6rem; }
.muted { color: var(--muted); }
#subtitle:empty { display: none; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 6px 12px; }
.stat b { display: block; font-size: 1.15rem; }
.stat span { font-size: 12px; color: var(--muted); }
.layout { max-width: 1200px; margin: 0 auto; padding: 8px 16px 24px; display: grid; gap: 16px; }
.map-wrap { position: sticky; top: 0; z-index: 1; display: flex; height: 45vh; min-height: 280px; border-radius: 12px; border: 1px solid var(--border); overflow: hidden; background: var(--bg); }
#map { flex: 1; height: 100%; }
@media (min-width: 900px) {
  .layout { grid-template-columns: 1.3fr 1fr; align-items: start; }
  .map-wrap { height: calc(100vh - 32px); top: 16px; }
}
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { position: relative; padding: 0 0 18px 28px; cursor: pointer; border-radius: 8px; }
.timeline li::before { content: ''; position: absolute; left: 9px; top: 18px; bottom: -2px; width: 2px; background: var(--border); }
.timeline li:last-child::before { display: none; }
.dot { position: absolute; left: 0; top: 2px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; color: #fff; background: var(--accent); }
.when { font-size: 13px; color: var(--muted); }
.timeline h3 { margin: 0; font-size: 1rem; }
.timeline p { margin: 2px 0 0; }
.timeline img { display: block; width: 100%; max-height: 360px; object-fit: cover; border-radius: 10px; margin-top: 6px; background: var(--card); }
.timeline img.pano { max-height: 200px; }
.timeline li.active h3, .timeline li.near h3 { color: var(--accent); }
.timeline li.near { background: var(--card); box-shadow: -6px 0 0 var(--card), 6px 0 0 var(--card); }
.badge { display: inline-block; font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; margin-left: 4px; }
footer { text-align: center; font-size: 13px; padding: 8px 16px 32px; }
.thumb-pin { width: 38px; height: 38px; border-radius: 8px; overflow: hidden; border: 2px solid #fff; box-shadow: 0 1px 4px rgb(0 0 0 / 0.5); }
.thumb-pin img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pt-pin { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; display: grid; place-items: center; color: #fff; font-size: 12px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.5); }
.legend { background: rgb(255 255 255 / 0.92); color: #1d2a30; border-radius: 8px; padding: 6px 10px; font-size: 12px; line-height: 1.6; box-shadow: 0 1px 4px rgb(0 0 0 / 0.3); }
.legend .row { display: flex; align-items: center; gap: 6px; }
.legend svg { flex: none; }
.legend .ramp { width: 90px; height: 8px; border-radius: 4px; }
.legend .scale { display: flex; justify-content: space-between; width: 90px; font-size: 11px; color: #61727a; }
/* Sun strip across the top of the map: time runs left to right */
.map-wrap { flex-direction: column; }
.sun { height: 78px; flex: none; display: flex; border-bottom: 1px solid var(--border); font-size: 12px; line-height: 1.35; background: #123c52; }
.sun[hidden] { display: none; }
.sun .info { width: 110px; flex: none; display: flex; flex-direction: column; justify-content: center; padding: 4px 8px; background: var(--bg); border-right: 1px solid var(--border); }
.sun .info b { font-size: 14px; }
.sun .gauge { position: relative; flex: 1; min-width: 0; overflow: hidden; }
.sun svg { position: absolute; left: 0; top: 0; display: block; }
.sun-dot { position: absolute; width: 16px; height: 16px; transform: translate(-50%, -50%); border-radius: 50%; background: #ffd23f; border: 2px solid #fff; box-shadow: 0 0 10px 3px rgb(255 210 63 / 0.7); }
#map { min-height: 0; }
.viewer { position: fixed; inset: 0; background: #000; z-index: 2000; display: flex; flex-direction: column; }
.viewer[hidden] { display: none; }
.viewer-scroll { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; }
.viewer-scroll img { max-width: 100%; max-height: 100%; object-fit: contain; }
.viewer.pano .viewer-scroll { justify-content: flex-start; }
.viewer.pano .viewer-scroll img { max-width: none; height: 100%; width: auto; }
.viewer-caption { color: #ddd; padding: 10px 16px; font-size: 14px; }
#viewer-close { position: absolute; top: 12px; right: 12px; width: 40px; height: 40px; border-radius: 50%; border: 0; background: rgb(255 255 255 / 0.85); font-size: 18px; cursor: pointer; }
`;

// Runs inside the report page (plain JS, no imports).
const SCRIPT = `
(function () {
  var d = JSON.parse(document.getElementById('data').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var fmtDate = function (t) { return new Date(t).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); };
  var fmtTime = function (t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  var fmtDur = function (ms) { var m = Math.round(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  var RAD = Math.PI / 180;
  var MI_PER_KM = 0.621371;
  function distKm(a, b) {
    var dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 12742 * Math.asin(Math.sqrt(h));
  }

  // ---------- header ----------
  $('title').textContent = d.title;
  $('date').textContent = fmtDate(d.date);
  $('subtitle').textContent = d.subtitle;
  $('generated').textContent = 'report made ' + fmtDate(d.generated);
  var s = d.stats, stats = [];
  if (s.distanceMi != null) stats.push([s.distanceMi.toFixed(1) + ' mi', 'distance']);
  if (s.totalMs) stats.push([fmtDur(s.totalMs), 'total time']);
  if (s.movingMs) stats.push([fmtDur(s.movingMs), 'moving']);
  if (s.avgMph) stats.push([s.avgMph.toFixed(1) + ' mph', 'average moving speed']);
  if (s.photos) stats.push([String(s.photos), s.photos === 1 ? 'photo' : 'photos']);
  if (d.show && !d.show.stats) stats = [];
  stats.forEach(function (x) {
    var el = document.createElement('div'); el.className = 'stat';
    var b = document.createElement('b'); b.textContent = x[0];
    var sp = document.createElement('span'); sp.textContent = x[1];
    el.append(b, sp); $('stats').append(el);
  });

  // ---------- map ----------
  // Scroll wheel zooms the map while the pointer is over it; elsewhere it scrolls the page.
  var map = L.map('map', { scrollWheelZoom: true });
  L.tileLayer(d.tiles.url, { maxNativeZoom: d.tiles.maxNativeZoom, maxZoom: 18, attribution: d.tiles.attribution }).addTo(map);
  var bounds = L.latLngBounds([]);
  var show = d.show || { stats: true, sun: true, speed: true, legend: true };
  // Each GPS track: its fixes [lat, lng, time] and whether it has usable times.
  // wa..wb: the fixes on the water (from the put-in to the take-out); the rest is e.g. driving.
  var segs = (d.tracks || []).map(function (t, i) { return { pts: t, water: (d.water || [])[i] }; })
    .filter(function (s) { return s.pts.length > 1; })
    .map(function (s) {
      var t = s.pts, wa = 0, wb = t.length - 1;
      if (s.water) {
        while (wa < t.length - 1 && t[wa][2] < s.water[0]) wa++;
        while (wb > wa && t[wb][2] > s.water[1]) wb--;
      }
      return { pts: t, ll: t.map(function (p) { return [p[0], p[1]]; }), wa: wa, wb: wb,
        timed: t[0][2] > 0 && t[t.length - 1][2] > t[0][2] && wb > wa };
    });
  var anyTimed = segs.some(function (s) { return s.timed; });
  if (d.route.length) { var r = L.polyline(d.route, { color: d.routeColor, weight: 4, opacity: 0.5, dashArray: '8 8' }).addTo(map); bounds.extend(r.getBounds()); }
  var TRACK_COLOR = '#37474f';
  segs.forEach(function (s) { bounds.extend(L.latLngBounds(s.ll)); });

  // ---------- speed: each track split wherever the pace changed ----------
  // Slow purple to fast yellow: stands out on blue water and the topo map.
  var RAMP = ['#5e35b1', '#c2185b', '#f4511e', '#ffb300', '#ffee58'];
  var STOP_COLOR = '#9e9e9e';
  var STOP_MPH = 0.4;
  function mix(a, b, f) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var ch = function (sh) { return Math.round(((pa >> sh) & 255) * (1 - f) + ((pb >> sh) & 255) * f); };
    return 'rgb(' + ch(16) + ',' + ch(8) + ',' + ch(0) + ')';
  }
  function rampColor(f) {
    f = Math.max(0, Math.min(1, f)) * (RAMP.length - 1);
    var i = Math.min(RAMP.length - 2, Math.floor(f));
    return mix(RAMP[i], RAMP[i + 1], f - i);
  }
  function computeRuns(track) {
    // Distance along a stretch, measured between fixes at least 30 s apart: adding up every
    // fix would count GPS jitter as movement (standing still would look like ~2 mph).
    var runKm = function (a, b) {
      var km = 0, prev = a;
      for (var i = a + 1; i <= b; i++) {
        if (i === b || track[i][2] - track[prev][2] >= 30000) { km += distKm(track[prev], track[i]); prev = i; }
      }
      return km;
    };
    // Speed at each fix: how far you got over a minute either side (jitter cancels out).
    var HALF = 60000, smooth = [], lo = 0, hi = 0;
    for (var i = 0; i < track.length; i++) {
      var t = track[i][2];
      while (track[lo][2] < t - HALF) lo++;
      while (hi < track.length - 1 && track[hi + 1][2] <= t + HALF) hi++;
      var dt = track[hi][2] - track[lo][2];
      smooth.push(dt > 0 ? (distKm(track[lo], track[hi]) * MI_PER_KM) / (dt / 3600000) : 0);
    }
    // Grow a run while the pace stays within a band of its average; start a new one when it changes.
    var runs = [], start = 0;
    for (var i = 1; i < track.length; i++) {
      var avg = 0, nAvg = 0;
      for (var j = start; j < i; j++) { avg += smooth[j]; nAvg++; }
      avg /= nAvg;
      var v = smooth[i];
      var stoppedNow = v < STOP_MPH, stoppedRun = avg < STOP_MPH;
      var tol = Math.max(0.35, 0.15 * avg);
      if (i - 1 > start && (stoppedNow !== stoppedRun || (!stoppedNow && Math.abs(v - avg) > tol))) {
        runs.push([start, i - 1]);
        start = i - 1;
      }
    }
    runs.push([start, track.length - 1]);
    // Describe each run; fold blips under 40 s into the neighbour with the closest pace.
    var describe = function (a, b) {
      var ms = track[b][2] - track[a][2], mi = runKm(a, b) * MI_PER_KM;
      return { a: a, b: b, ms: ms, mi: mi, mph: ms > 0 ? mi / (ms / 3600000) : 0 };
    };
    runs = runs.map(function (x) { return describe(x[0], x[1]); });
    for (var pass = 0; pass < 3; pass++) {
      for (var k = 0; k < runs.length; k++) {
        if (runs[k].ms >= 40000 || runs.length < 2) continue;
        var prev = runs[k - 1], next = runs[k + 1];
        var into = !prev ? k + 1 : !next ? k - 1 : Math.abs(prev.mph - runs[k].mph) <= Math.abs(next.mph - runs[k].mph) ? k - 1 : k + 1;
        var m = describe(Math.min(runs[into].a, runs[k].a), Math.max(runs[into].b, runs[k].b));
        runs.splice(Math.min(into, k), 2, m);
        k--;
      }
    }
    return runs;
  }
  // Every hoverable piece of track: { seg, line, hit } (one per speed section, or one per track).
  var pieces = [];
  var speedRange = null, anyStops = false;
  var useSpeed = show.speed && anyTimed;
  if (useSpeed) {
    segs.forEach(function (s) { if (s.timed) s.runs = computeRuns(s.pts.slice(s.wa, s.wb + 1)); });
    var moving = [];
    segs.forEach(function (s) { (s.runs || []).forEach(function (x) { if (x.mph >= STOP_MPH) moving.push(x.mph); else anyStops = true; }); });
    if (moving.length) speedRange = [Math.min.apply(null, moving), Math.max.apply(null, moving)];
  }
  var OFF_WATER_COLOR = '#78909c';
  var anyOffWater = false;
  segs.forEach(function (s) {
    // Before the put-in and after the take-out: thin and dashed, no speed colours.
    if (s.wa > 0) { anyOffWater = true; L.polyline(s.ll.slice(0, s.wa + 1), { color: OFF_WATER_COLOR, weight: 2, opacity: 0.8, dashArray: '4 6', interactive: false }).addTo(map); }
    if (s.wb < s.ll.length - 1) { anyOffWater = true; L.polyline(s.ll.slice(s.wb), { color: OFF_WATER_COLOR, weight: 2, opacity: 0.8, dashArray: '4 6', interactive: false }).addTo(map); }
    var water = s.ll.slice(s.wa, s.wb + 1);
    if (!s.runs) {
      var line = L.polyline(water, { color: TRACK_COLOR, weight: 3, opacity: 0.85, interactive: false }).addTo(map);
      pieces.push({ seg: s, line: line, hit: L.polyline(water, { weight: 22, opacity: 0 }).addTo(map) });
      return;
    }
    s.runs.forEach(function (x) {
      var stopped = x.mph < STOP_MPH;
      var lo = speedRange ? speedRange[0] : 0, hi = speedRange ? speedRange[1] : 0;
      var color = stopped ? STOP_COLOR : rampColor(hi - lo < 0.1 ? 0.5 : (x.mph - lo) / (hi - lo));
      var pts = s.ll.slice(s.wa + x.a, s.wa + x.b + 1);
      // Round joins and caps let neighbouring sections flow into each other.
      var line = L.polyline(pts, { color: color, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map);
      // A wide invisible copy makes the section easy to hover.
      var hit = L.polyline(pts, { weight: 22, opacity: 0 }).addTo(map);
      var label = (stopped ? 'Stopped' : x.mph.toFixed(1) + ' mph') + ' · ' + fmtDur(x.ms) +
        (stopped ? '' : ' · ' + x.mi.toFixed(x.mi < 1 ? 2 : 1) + ' mi') + '<br>' + fmtTime(s.pts[s.wa + x.a][2]) + '–' + fmtTime(s.pts[s.wa + x.b][2]);
      hit.bindTooltip(label, { sticky: true, direction: 'top', offset: [0, -10] });
      hit.on('mouseover', function () { line.setStyle({ weight: 8 }); });
      hit.on('mouseout', function () { line.setStyle({ weight: 5 }); });
      pieces.push({ seg: s, line: line, hit: hit });
    });
  });

  // ---------- legend ----------
  var legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function () {
    var div = L.DomUtil.create('div', 'legend');
    var h = '';
    if (d.route.length) h += '<div class="row"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="' + esc(d.routeColor) + '" stroke-width="3" stroke-dasharray="6 4" opacity="0.7"/></svg>Planned route</div>';
    if (segs.length && !speedRange) h += '<div class="row"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="' + TRACK_COLOR + '" stroke-width="2.5"/></svg>GPS track</div>';
    if (speedRange) {
      h += '<div>GPS track, by speed</div><div class="ramp" style="background:linear-gradient(90deg,' + RAMP.join(',') + ')"></div>' +
        '<div class="scale"><span>' + speedRange[0].toFixed(1) + '</span><span>' + speedRange[1].toFixed(1) + ' mph</span></div>';
      if (anyStops) h += '<div class="row"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="' + STOP_COLOR + '" stroke-width="4"/></svg>Stopped</div>';
    }
    if (anyOffWater) h += '<div class="row"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="' + OFF_WATER_COLOR + '" stroke-width="2" stroke-dasharray="4 4"/></svg>Before put-in / after take-out</div>';
    div.innerHTML = h;
    return div;
  };
  if (show.legend && (d.route.length || segs.length)) legend.addTo(map);

  // ---------- markers & timeline ----------
  var markers = [];
  d.items.forEach(function (it, i) {
    if (!it.at) return;
    var html;
    if (it.kind === 'photo') html = '<div class="thumb-pin"><img src="' + d.photos[it.photo].src + '" alt=""></div>';
    else if (it.kind === 'point') html = '<div class="pt-pin" style="background:' + (it.color || '#0f4c5c') + '">' + esc(it.icon || '') + '</div>';
    else html = '<div class="pt-pin" style="background:' + (it.kind === 'start' ? '#2e7d32' : '#c62828') + '"></div>';
    var size = it.kind === 'photo' ? 42 : 24;
    var m = L.marker(it.at, { icon: L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) }).addTo(map);
    m.on('click', function () { select(i, true); });
    markers[i] = m;
    bounds.extend(it.at);
  });
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] }); else map.setView([35, -85], 6);

  var lis = [];
  d.items.forEach(function (it, i) {
    var li = document.createElement('li');
    var dot = document.createElement('span'); dot.className = 'dot';
    dot.style.background = it.kind === 'start' ? '#2e7d32' : it.kind === 'finish' ? '#c62828' : it.kind === 'photo' ? '#0f4c5c' : (it.color || '#0f4c5c');
    dot.textContent = it.kind === 'photo' ? '◉' : it.kind === 'point' ? (it.icon || '•') : '';
    var when = document.createElement('div'); when.className = 'when';
    when.textContent = [it.time ? fmtTime(it.time) : '', it.mile != null ? 'mile ' + it.mile.toFixed(1) : ''].filter(Boolean).join(' · ');
    var h = document.createElement('h3'); h.textContent = it.title;
    if (it.category) { var bd = document.createElement('span'); bd.className = 'badge'; bd.textContent = it.category; h.append(bd); }
    li.append(dot, when, h);
    if (it.text) { var p = document.createElement('p'); p.textContent = it.text; li.append(p); }
    if (it.kind === 'photo') {
      var img = document.createElement('img'); img.src = d.photos[it.photo].src; img.alt = it.title; img.loading = 'lazy';
      if (d.photos[it.photo].panorama) img.className = 'pano';
      img.addEventListener('click', function (e) { e.stopPropagation(); openViewer(it); });
      li.append(img);
    }
    li.addEventListener('click', function () { select(i, false); });
    $('timeline').append(li); lis[i] = li;
  });

  function select(i, fromMap) {
    lis.forEach(function (li, j) { if (li) li.classList.toggle('active', j === i); });
    var it = d.items[i];
    if (it.at) map.flyTo(it.at, Math.max(map.getZoom(), 15), { duration: 0.6 });
    if (fromMap && lis[i]) lis[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (it.time) showSun(it.time);
  }

  // ---------- hovering the track: follow along in the timeline ----------
  if (anyTimed) {
    var hover = L.circleMarker([0, 0], { radius: 6, color: '#fff', weight: 2, fillColor: TRACK_COLOR, fillOpacity: 1, interactive: false });
    var nearIdx = -1, last = 0;
    var follow = function (e) {
      var now = Date.now();
      if (now - last < 60) return;
      last = now;
      var best = null, bd = Infinity;
      segs.forEach(function (s) {
        if (!s.timed) return;
        for (var i = 0; i < s.pts.length; i++) {
          var dd = Math.pow(s.pts[i][0] - e.latlng.lat, 2) + Math.pow((s.pts[i][1] - e.latlng.lng) * Math.cos(e.latlng.lat * RAD), 2);
          if (dd < bd) { bd = dd; best = s.pts[i]; }
        }
      });
      if (!best) return;
      var t = best[2];
      hover.setLatLng([best[0], best[1]]).addTo(map);
      showSun(t);
      // The timeline entry closest in time (a photo or point from that part of the trip).
      var ni = -1, nd = Infinity;
      d.items.forEach(function (it, j) {
        if (!it.time || it.kind === 'start' || it.kind === 'finish') return;
        var diff = Math.abs(it.time - t);
        if (diff < nd) { nd = diff; ni = j; }
      });
      if (ni !== nearIdx) {
        if (lis[nearIdx]) lis[nearIdx].classList.remove('near');
        nearIdx = ni;
        if (lis[ni]) { lis[ni].classList.add('near'); lis[ni].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      }
    };
    pieces.forEach(function (p) {
      if (!p.seg.timed) return;
      p.hit.on('mousemove', follow);
      p.hit.on('click', follow);
      p.hit.on('mouseout', function () { hover.remove(); });
    });
  }

  // ---------- sun: its path across the sky during the trip ----------
  // Sun altitude from date, time and place (formulas as in SunCalc / NOAA).
  function sunAlt(t, lat, lng) {
    var dd = t / 86400000 - 0.5 + 2440588 - 2451545;
    var M = RAD * (357.5291 + 0.98560028 * dd);
    var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var Lm = M + C + RAD * 102.9372 + Math.PI;
    var e = RAD * 23.4397;
    var dec = Math.asin(Math.sin(e) * Math.sin(Lm));
    var ra = Math.atan2(Math.sin(Lm) * Math.cos(e), Math.cos(Lm));
    var H = RAD * (280.16 + 360.9856235 * dd) + RAD * lng - ra;
    var phi = RAD * lat;
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / RAD;
  }
  var SUNSET_ALT = -0.833;
  function nextSunset(t, lat, lng) {
    var prev = sunAlt(t, lat, lng);
    for (var x = t + 60000; x < t + 20 * 3600000; x += 60000) {
      var a = sunAlt(x, lat, lng);
      if (prev >= SUNSET_ALT && a < SUNSET_ALT) return x;
      prev = a;
    }
    return null;
  }
  var showSun = function () {};
  if (show.sun && anyTimed) {
    // Across all chosen tracks; tracks on different days use the first one.
    var timedSegs = segs.filter(function (s) { return s.timed; }).sort(function (a, b) { return a.pts[a.wa][2] - b.pts[b.wa][2]; });
    var firstSeg = timedSegs[0];
    var lat = firstSeg.pts[firstSeg.wa][0], lng = firstSeg.pts[firstSeg.wa][1], tStart = firstSeg.pts[firstSeg.wa][2];
    var tFinish = Math.max.apply(null, timedSegs.map(function (s) { return s.pts[s.wb][2]; }));
    if (tFinish - tStart > 20 * 3600000) tFinish = firstSeg.pts[firstSeg.wb][2];
    // Height scale: the water line up to the day's highest sun, so a late paddle sits low in the sky.
    var noonAlt = 10;
    for (var x = tStart - 12 * 3600000; x < tStart + 12 * 3600000; x += 10 * 60000) noonAlt = Math.max(noonAlt, sunAlt(x, lat, lng));
    var TOP = noonAlt + 4, BOTTOM = -14;
    var sunset = nextSunset(tStart - 6 * 3600000, lat, lng);
    if (sunset && sunset < tStart - 60000) sunset = nextSunset(tStart, lat, lng);
    var panel = $('sun');
    panel.innerHTML = '<div class="info" id="sun-note"></div><div class="gauge" id="sun-gauge"></div>';
    panel.title = "The sun's path across the sky during the trip, above the water line.";
    panel.hidden = false;
    map.invalidateSize();
    var geom = null;
    var drawSun = function () {
      var g = $('sun-gauge');
      var w = g.clientWidth, h = g.clientHeight;
      if (!w || !h) return;
      var pad = 12;
      var yOf = function (alt) { return ((TOP - alt) / (TOP - BOTTOM)) * h; };
      var xOf = function (t) { return pad + ((t - tStart) / Math.max(1, tFinish - tStart)) * (w - 2 * pad); };
      var hz = yOf(0);
      // The sun's path, sampled every minute of the trip.
      var pts = [];
      var step = Math.max(60000, (tFinish - tStart) / 200);
      for (var t = tStart; t <= tFinish + 1; t += step) pts.push(xOf(t).toFixed(1) + ',' + yOf(sunAlt(t, lat, lng)).toFixed(1));
      pts.push(xOf(tFinish).toFixed(1) + ',' + yOf(sunAlt(tFinish, lat, lng)).toFixed(1));
      // Water: a gently wavy surface at the horizon.
      var wave = 'M0,' + hz.toFixed(1);
      for (var x = 0; x <= w; x += 8) wave += ' Q' + (x + 4) + ',' + ((x / 8) % 2 === 0 ? hz - 2.2 : hz + 2.2).toFixed(1) + ' ' + (x + 8) + ',' + hz.toFixed(1);
      wave += ' L' + (w + 8) + ',' + (g.clientHeight + 2) + ' L0,' + (g.clientHeight + 2) + ' Z';
      g.innerHTML =
        '<svg width="' + w + '" height="' + g.clientHeight + '" viewBox="0 0 ' + w + ' ' + g.clientHeight + '" aria-hidden="true">' +
        '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d8fd1"/><stop offset="1" stop-color="#cfe8f7"/></linearGradient>' +
        '<linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f8fae"/><stop offset="1" stop-color="#123c52"/></linearGradient></defs>' +
        '<rect x="0" y="0" width="' + w + '" height="' + (hz + 3) + '" fill="url(#sky)"/>' +
        '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#fff6c2" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 4"/>' +
        '<path d="' + wave + '" fill="url(#water)" opacity="0.93"/>' +
        '<path d="' + wave.split(' L')[0] + '" fill="none" stroke="#e8f6ff" stroke-width="1" opacity="0.8"/>' +
        '</svg><div id="sun-dot" class="sun-dot"></div>';
      geom = { xOf: xOf, yOf: yOf, h: h };
    };
    showSun = function (t) {
      if (!geom) drawSun();
      if (!geom) return;
      var dot = $('sun-dot');
      dot.style.left = geom.xOf(Math.max(tStart, Math.min(tFinish, t))) + 'px';
      dot.style.top = geom.yOf(sunAlt(t, lat, lng)) + 'px';
      var note;
      if (sunset && t < sunset) {
        var left = sunset - t;
        note = left < 3 * 3600000 ? fmtDur(left) + ' to sunset' : 'sunset ' + fmtTime(sunset);
      } else note = sunAlt(t, lat, lng) < SUNSET_ALT ? 'after sunset' : '';
      $('sun-note').innerHTML = '<b>' + esc(fmtTime(t)) + '</b>' + (note ? '<br>' + esc(note) : '');
      currentSun = t;
    };
    var currentSun = tStart;
    drawSun();
    showSun(tStart);
    window.addEventListener('resize', function () { geom = null; drawSun(); showSun(currentSun); });
  }

  // ---------- photo viewer ----------
  function openViewer(it) {
    var ph = d.photos[it.photo];
    $('viewer').classList.toggle('pano', ph.panorama);
    $('viewer-img').src = ph.src;
    $('viewer-caption').textContent = [it.title, it.time ? fmtTime(it.time) : '', it.text].filter(Boolean).join(' · ') + (ph.panorama ? ' · swipe to look around' : '');
    $('viewer').hidden = false;
    var sc = $('viewer').querySelector('.viewer-scroll');
    $('viewer-img').onload = function () { sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2; };
  }
  $('viewer-close').addEventListener('click', function () { $('viewer').hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('viewer').hidden = true; });
})();
`;
