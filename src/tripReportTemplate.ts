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
  /** [lat, lng, time ms (0 if unknown)] */
  track: [number, number, number][];
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
.speed-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.35); }
.legend { background: rgb(255 255 255 / 0.92); color: #1d2a30; border-radius: 8px; padding: 6px 10px; font-size: 12px; line-height: 1.6; box-shadow: 0 1px 4px rgb(0 0 0 / 0.3); }
.legend .row { display: flex; align-items: center; gap: 6px; }
.legend svg { flex: none; }
.legend .ramp { width: 90px; height: 8px; border-radius: 4px; }
.legend .scale { display: flex; justify-content: space-between; width: 90px; font-size: 11px; color: #61727a; }
/* Sun gauge, left of the map */
.sun { width: 64px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--border); font-size: 11px; line-height: 1.3; text-align: center; }
.sun[hidden] { display: none; }
.sun .gauge { position: relative; flex: 1; min-height: 0; }
.sun svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.sun-dot { position: absolute; left: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: #ffd23f; border: 2px solid #fff; box-shadow: 0 0 10px 3px rgb(255 210 63 / 0.7); transition: top 0.15s; }
.sun .info { padding: 6px 2px; border-bottom: 1px solid var(--border); }
.sun .alt { font-size: 15px; font-weight: 700; }
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
  var track = d.track;
  var trackLL = track.map(function (p) { return [p[0], p[1]]; });
  var timed = track.length > 1 && track[0][2] > 0 && track[track.length - 1][2] > track[0][2];
  if (d.route.length) { var r = L.polyline(d.route, { color: d.routeColor, weight: 4, opacity: 0.5, dashArray: '8 8' }).addTo(map); bounds.extend(r.getBounds()); }
  var TRACK_COLOR = '#37474f';
  if (track.length) { var tl = L.polyline(trackLL, { color: TRACK_COLOR, weight: 2.5, opacity: 0.85, interactive: false }).addTo(map); bounds.extend(tl.getBounds()); }

  // ---------- speed: a dot every 10 minutes, coloured relative to the trip ----------
  var RAMP = ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'];
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
  function posAt(t) {
    for (var i = 1; i < track.length; i++) {
      if (track[i][2] >= t) {
        var a = track[i - 1], b = track[i], f = b[2] > a[2] ? (t - a[2]) / (b[2] - a[2]) : 0;
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      }
    }
    return trackLL[trackLL.length - 1];
  }
  var speedRange = null;
  if (timed) {
    var WIN = 10 * 60000, t0 = track[0][2], tEnd = track[track.length - 1][2], wins = [];
    for (var w = t0; w < tEnd; w += WIN) {
      var km = 0, ms = 0;
      for (var i = 1; i < track.length; i++) {
        var a = track[i - 1], b = track[i];
        if (a[2] < w || b[2] > w + WIN || b[2] <= a[2]) continue;
        km += distKm(a, b); ms += b[2] - a[2];
      }
      if (ms >= 2 * 60000) wins.push({ start: w, end: Math.min(w + WIN, tEnd), mph: (km * MI_PER_KM) / (ms / 3600000) });
    }
    if (wins.length) {
      var lo = Math.min.apply(null, wins.map(function (x) { return x.mph; }));
      var hi = Math.max.apply(null, wins.map(function (x) { return x.mph; }));
      speedRange = [lo, hi];
      wins.forEach(function (x) {
        var f = hi - lo < 0.1 ? 0.5 : (x.mph - lo) / (hi - lo);
        var m = L.marker(posAt((x.start + x.end) / 2), {
          icon: L.divIcon({ className: '', html: '<div class="speed-dot" style="background:' + rampColor(f) + '"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
          zIndexOffset: -100,
        }).addTo(map);
        m.bindTooltip(fmtTime(x.start) + '–' + fmtTime(x.end) + ' · ' + x.mph.toFixed(1) + ' mph', { direction: 'top', offset: [0, -6] });
      });
    }
  }

  // ---------- legend ----------
  var legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function () {
    var div = L.DomUtil.create('div', 'legend');
    var h = '';
    if (d.route.length) h += '<div class="row"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="' + esc(d.routeColor) + '" stroke-width="3" stroke-dasharray="6 4" opacity="0.7"/></svg>Planned route</div>';
    if (track.length) h += '<div class="row"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="' + TRACK_COLOR + '" stroke-width="2.5"/></svg>GPS track</div>';
    if (speedRange) {
      h += '<div>Speed, every 10 min</div><div class="ramp" style="background:linear-gradient(90deg,' + RAMP.join(',') + ')"></div>' +
        '<div class="scale"><span>' + speedRange[0].toFixed(1) + '</span><span>' + speedRange[1].toFixed(1) + ' mph</span></div>';
    }
    div.innerHTML = h;
    return div;
  };
  if (d.route.length || track.length) legend.addTo(map);

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
  if (timed) {
    var hover = L.circleMarker(trackLL[0], { radius: 7, color: '#fff', weight: 2, fillColor: TRACK_COLOR, fillOpacity: 1, interactive: false });
    var hit = L.polyline(trackLL, { weight: 24, opacity: 0, interactive: true }).addTo(map);
    var nearIdx = -1, last = 0;
    var follow = function (e) {
      var now = Date.now();
      if (now - last < 60) return;
      last = now;
      var best = 0, bd = Infinity;
      for (var i = 0; i < track.length; i++) {
        var dd = Math.pow(track[i][0] - e.latlng.lat, 2) + Math.pow((track[i][1] - e.latlng.lng) * Math.cos(e.latlng.lat * RAD), 2);
        if (dd < bd) { bd = dd; best = i; }
      }
      var t = track[best][2];
      hover.setLatLng(trackLL[best]).addTo(map);
      hover.bindTooltip(fmtTime(t), { permanent: true, direction: 'right', offset: [8, 0] }).openTooltip();
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
    hit.on('mousemove', follow);
    hit.on('click', follow);
    hit.on('mouseout', function () { hover.remove(); });
  }

  // ---------- sun gauge ----------
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
  if (timed) {
    var lat = track[0][0], lng = track[0][1], tStart = track[0][2], tFinish = track[track.length - 1][2];
    // Scale: from a little below the horizon to the day's highest sun.
    var noonAlt = 0;
    for (var x = tStart - 12 * 3600000; x < tStart + 12 * 3600000; x += 10 * 60000) noonAlt = Math.max(noonAlt, sunAlt(x, lat, lng));
    var top = Math.max(20, Math.ceil(noonAlt / 10) * 10), bottom = -15;
    var tripLo = Infinity, tripHi = -Infinity;
    for (var y = tStart; y <= tFinish; y += 60000) { var al = sunAlt(y, lat, lng); tripLo = Math.min(tripLo, al); tripHi = Math.max(tripHi, al); }
    var sunset = nextSunset(tStart - 6 * 3600000, lat, lng);
    if (sunset && sunset < tStart - 60000) sunset = nextSunset(tStart, lat, lng);
    var H = 100, yOf = function (alt) { return ((top - alt) / (top - bottom)) * H; };
    var hz = yOf(0);
    $('sun').innerHTML =
      '<div class="info"><div id="sun-alt" class="alt"></div><div id="sun-note"></div></div>' +
      '<div class="gauge"><svg viewBox="0 0 40 ' + H + '" preserveAspectRatio="none" aria-label="Sun height">' +
      '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4fa3e0"/><stop offset="1" stop-color="#cfe8f7"/></linearGradient>' +
      '<linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0a35e"/><stop offset="1" stop-color="#3b3355"/></linearGradient></defs>' +
      '<rect x="0" y="0" width="40" height="' + hz + '" fill="url(#sky)"/>' +
      '<rect x="0" y="' + hz + '" width="40" height="' + (H - hz) + '" fill="url(#dusk)"/>' +
      '<line x1="0" y1="' + hz + '" x2="40" y2="' + hz + '" stroke="#fff" stroke-width="0.6"/>' +
      '<rect x="17" y="' + yOf(tripHi) + '" width="6" height="' + Math.max(0.8, yOf(tripLo) - yOf(tripHi)) + '" rx="3" fill="#fff" opacity="0.55"/>' +
      '</svg><div id="sun-dot" class="sun-dot"></div></div>';
    $('sun').title = 'How high the sun was. The pale bar is the range during the trip; the line is the horizon.';
    $('sun').hidden = false;
    map.invalidateSize();
    showSun = function (t) {
      var alt = sunAlt(t, lat, lng);
      $('sun-dot').style.top = Math.max(2, Math.min(98, yOf(alt))) + '%';
      $('sun-alt').textContent = Math.round(alt) + '°';
      var note;
      if (sunset && t < sunset) {
        var left = sunset - t;
        note = left < 3 * 3600000 ? fmtDur(left) + ' to sunset' : 'sunset ' + fmtTime(sunset);
      } else note = alt < SUNSET_ALT ? 'after sunset' : '';
      $('sun-note').innerHTML = esc(fmtTime(t)) + (note ? '<br>' + esc(note) : '');
    };
    showSun(tStart);
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
