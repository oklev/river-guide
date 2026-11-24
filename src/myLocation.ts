import L from 'leaflet';
import { map } from './map';
import { distKm } from './geo';
import type { LatLng } from './types';
import { $, prefs } from './ui';

/**
 * "You are here": a live marker that follows the phone's position while the
 * app is open. It's a blue dot, or a kayak, paddleboard or canoe that turns to
 * point the way you're heading. An accuracy circle shows how sure the GPS is.
 */
export type LocationIcon = 'dot' | 'kayak' | 'sup' | 'canoe';
export const LOCATION_ICONS: Record<LocationIcon, string> = {
  dot: 'Blue dot',
  kayak: 'Kayak',
  sup: 'Paddleboard',
  canoe: 'Canoe',
};

const BLUE = '#1e88e5';
/** Below this speed (m/s) GPS headings are noise, so the last good heading is kept. */
const MIN_SPEED = 0.4;
/** Or work the heading out from movement once you've gone this far (km). */
const MIN_MOVE_KM = 0.008;

// Top-down boats pointing up (north), drawn in a 24 x 64 box.
const BOATS: Record<Exclude<LocationIcon, 'dot'>, { w: number; h: number; svg: string }> = {
  kayak: {
    w: 24,
    h: 64,
    svg: `
      <line x1="1" y1="30" x2="23" y2="30" stroke="#263238" stroke-width="1.6" stroke-linecap="round"/>
      <ellipse cx="2.5" cy="30" rx="2.2" ry="5" fill="#ffca28" stroke="#263238" stroke-width="0.8"/>
      <ellipse cx="21.5" cy="30" rx="2.2" ry="5" fill="#ffca28" stroke="#263238" stroke-width="0.8"/>
      <path d="M12 2 C17 14 17.5 46 12 62 C6.5 46 7 14 12 2 Z" fill="${BLUE}" stroke="#fff" stroke-width="1.6"/>
      <ellipse cx="12" cy="33" rx="3" ry="6" fill="#0d3c61"/>`,
  },
  sup: {
    w: 24,
    h: 64,
    svg: `
      <path d="M12 2 C18 8 18.5 20 18.5 34 C18.5 50 17 60 12 62 C7 60 5.5 50 5.5 34 C5.5 20 6 8 12 2 Z" fill="${BLUE}" stroke="#fff" stroke-width="1.6"/>
      <line x1="12" y1="10" x2="12" y2="56" stroke="#fff" stroke-width="0.8" opacity="0.6"/>
      <line x1="19" y1="20" x2="21" y2="48" stroke="#263238" stroke-width="1.4" stroke-linecap="round"/>
      <ellipse cx="21" cy="47" rx="1.8" ry="4" fill="#ffca28" stroke="#263238" stroke-width="0.8"/>
      <circle cx="12" cy="34" r="3.6" fill="#ffca28" stroke="#263238" stroke-width="1"/>`,
  },
  canoe: {
    w: 24,
    h: 64,
    svg: `
      <path d="M12 2 C20 12 21 44 12 62 C3 44 4 12 12 2 Z" fill="${BLUE}" stroke="#fff" stroke-width="1.6"/>
      <path d="M12 6 C18 15 18.5 43 12 58 C5.5 43 6 15 12 6 Z" fill="#0d3c61" opacity="0.35"/>
      <line x1="6.2" y1="20" x2="17.8" y2="20" stroke="#fff" stroke-width="1.6"/>
      <line x1="5.4" y1="32" x2="18.6" y2="32" stroke="#fff" stroke-width="1.6"/>
      <line x1="6.4" y1="44" x2="17.6" y2="44" stroke="#fff" stroke-width="1.6"/>`,
  },
};

let iconStyle: LocationIcon = 'dot';
let marker: L.Marker | null = null;
let accuracy: L.Circle | null = null;
let watchId: number | null = null;
let last: { at: LatLng; time: number } | null = null;
let lastMoveFrom: LatLng | null = null;
let heading: number | null = null;
/** Pan to the next fix (after tapping the locate button). */
let centerNext = false;
let userAsked = false;

function readStyle(): LocationIcon {
  const v = prefs.get('locationIcon');
  return v && v in LOCATION_ICONS ? (v as LocationIcon) : 'dot';
}

function bearing(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * toRad) * Math.cos(b[0] * toRad);
  const x =
    Math.cos(a[0] * toRad) * Math.sin(b[0] * toRad) -
    Math.sin(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.cos((b[1] - a[1]) * toRad);
  return ((Math.atan2(y, x) / toRad) + 360) % 360;
}

function makeIcon(): L.DivIcon {
  if (iconStyle === 'dot') {
    // A small wedge shows the heading once there is one.
    const wedge = heading == null ? '' : '<div class="me-wedge"></div>';
    return L.divIcon({
      className: '',
      html: `<div class="me-dot-wrap" style="--rot:${heading ?? 0}deg">${wedge}<div class="me-dot"></div></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }
  const b = BOATS[iconStyle];
  return L.divIcon({
    className: '',
    html: `<div class="me-boat" style="--rot:${heading ?? 0}deg"><svg viewBox="0 0 ${b.w} ${b.h}" width="${b.w}" height="${b.h}" aria-hidden="true">${b.svg}</svg></div>`,
    iconSize: [b.w, b.h],
    iconAnchor: [b.w / 2, b.h / 2],
  });
}

function redraw() {
  if (marker) marker.setIcon(makeIcon());
}

/** Listeners for live positions (trip progress). */
const positionListeners = new Set<(lat: number, lng: number, time: number) => void>();
export function onPosition(cb: (lat: number, lng: number, time: number) => void): () => void {
  positionListeners.add(cb);
  return () => positionListeners.delete(cb);
}

/** Start following the GPS if it isn't already (e.g. when a trip starts). */
export function ensureWatching() {
  startWatch();
}

function onFix(pos: GeolocationPosition) {
  const at: LatLng = [pos.coords.latitude, pos.coords.longitude];
  positionListeners.forEach((cb) => cb(at[0], at[1], pos.timestamp));
  // Heading: the GPS's own when moving, else from how far we've moved since the last turn.
  const gpsHeading = pos.coords.heading;
  const speed = pos.coords.speed;
  let newHeading = heading;
  if (gpsHeading != null && !Number.isNaN(gpsHeading) && (speed ?? 0) >= MIN_SPEED) newHeading = gpsHeading;
  else if (lastMoveFrom && distKm(lastMoveFrom, at) >= Math.max(MIN_MOVE_KM, pos.coords.accuracy / 1000)) {
    newHeading = bearing(lastMoveFrom, at);
  }
  if (!lastMoveFrom || newHeading !== heading) lastMoveFrom = at;
  const headingChanged = newHeading !== heading;
  heading = newHeading;
  last = { at, time: pos.timestamp };

  if (!marker) {
    accuracy = L.circle(at, { radius: pos.coords.accuracy, color: BLUE, weight: 1, opacity: 0.5, fillOpacity: 0.12, interactive: false });
    marker = L.marker(at, { icon: makeIcon(), interactive: false, keyboard: false, zIndexOffset: 1000 });
    accuracy.addTo(map);
    marker.addTo(map);
  } else {
    marker.setLatLng(at);
    accuracy!.setLatLng(at).setRadius(pos.coords.accuracy);
    if (headingChanged) redraw();
  }
  if (centerNext) {
    centerNext = false;
    map.setView(at, Math.max(map.getZoom(), 15));
  }
  userAsked = false; // got a fix: later hiccups aren't worth an alert
}

function onError(err: GeolocationPositionError) {
  // Only speak up when you tapped locate and no position has arrived (or it was refused).
  const recent = last && Date.now() - last.time < 60_000;
  if (userAsked && (err.code === err.PERMISSION_DENIED || !recent)) {
    userAsked = false;
    centerNext = false;
    alert(
      err.code === err.PERMISSION_DENIED
        ? "River Guide doesn't have permission to use your location. You can allow it in your browser or phone settings."
        : `Couldn't get your location: ${err.message}`,
    );
  }
}

function startWatch() {
  if (watchId != null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 });
}

function stopWatch() {
  if (watchId == null) return;
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

/** Locate button: show and center on your position. */
export function locateMe() {
  userAsked = true;
  if (last && Date.now() - last.time < 30_000) map.setView(last.at, Math.max(map.getZoom(), 15));
  else centerNext = true;
  startWatch();
}

export function setLocationIcon(style: LocationIcon) {
  iconStyle = style;
  prefs.set('locationIcon', style);
  redraw();
}

export function initMyLocation() {
  iconStyle = readStyle();
  const select = $<HTMLSelectElement>('location-icon');
  select.innerHTML = Object.entries(LOCATION_ICONS)
    .map(([v, label]) => `<option value="${v}">${label}</option>`)
    .join('');
  select.value = iconStyle;
  select.addEventListener('change', () => setLocationIcon(select.value as LocationIcon));
  $('locate').addEventListener('click', locateMe);

  // Show the marker straight away if location is already allowed; never prompt on startup.
  void navigator.permissions
    ?.query({ name: 'geolocation' })
    .then((p) => {
      if (p.state === 'granted') startWatch();
      p.addEventListener?.('change', () => (p.state === 'granted' ? startWatch() : stopWatch()));
    })
    .catch(() => {});

  // Save battery: only follow the GPS while the app is on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopWatch();
    else if (marker) startWatch();
  });
}
