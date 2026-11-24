export type Category =
  | 'hazard'
  | 'rapid'
  | 'access'
  | 'parking'
  | 'changing'
  | 'campsite'
  | 'poi'
  | 'shuttle'
  | 'gauge'
  | 'island'
  | 'bridge';

export type Severity = 'low' | 'medium' | 'high';

/** [lat, lng] */
export type LatLng = [number, number];

export type WaterLevel = 'low' | 'normal' | 'high' | 'flood';

export const WATER_LEVELS: Record<WaterLevel, string> = {
  low: 'Low water',
  normal: 'Normal water',
  high: 'High water',
  flood: 'Flood',
};

/** What a point looked like on one day. Conditions change with water level and season. */
export interface PointObservation {
  /** Local calendar date, YYYY-MM-DD. */
  observedAt?: string;
  description: string;
  severity?: Severity;
  waterLevel?: WaterLevel;
  /** Free text, e.g. "450 cfs at Athens gauge". */
  gauge?: string;
  /** When this observation was last edited (ISO timestamp). */
  recordedAt: string;
}

export interface RiverPoint extends Revisioned {
  id: string;
  name: string;
  category: Category;
  lat: number;
  lng: number;
  riverMile?: number;
  // The current (most recently observed) observation lives on the point itself,
  // so everything that reads points works unchanged; earlier ones are in history.
  description: string;
  severity?: Severity;
  observedAt?: string;
  waterLevel?: WaterLevel;
  gauge?: string;
  /** Earlier observations, newest first. */
  history?: PointObservation[];
  /** Optional line or area drawn for the point (a rapid, a bridge, an island). lat/lng stay its marker. */
  shape?: PointShape;
  /**
   * Access points: where this one meets a route. Absent = automatic (the
   * nearest spot on any route within 150 m); a spot picked by hand; or
   * detached (never attaches).
   */
  routeLink?: RouteLink;
  createdAt: string;
  updatedAt: string;
}

export type RouteLink = { routeId: string; branch: string; km: number } | { detached: true };

/** A point's line or area; an area's ring isn't closed (the first point isn't repeated). */
export interface PointShape {
  kind: 'line' | 'area';
  coords: LatLng[];
}

/** One downloaded corridor, remembered so its data can be deleted later. */
export interface OfflineArea {
  coords: LatLng[];
  bufferKm: number;
  maxZoom: number;
  osm: boolean;
}

export interface OfflineInfo {
  /** Every area downloaded for this route (a route may be re-downloaded with other settings). */
  areas?: OfflineArea[];
  bufferKm: number;
  maxZoom: number;
  tiles: number;
  failed: number;
  /** OpenStreetMap trail/park data tiles saved for this route, if requested. */
  osmTiles?: number;
  osmFailed?: number;
  downloadedAt: string;
  /** Route line was edited after the download, so the saved area may not cover it. */
  stale?: boolean;
  /** The last download was cancelled part-way. */
  partial?: boolean;
}

export interface Route extends Revisioned {
  id: string;
  name: string;
  description: string;
  color: string;
  /** Ordered from put-in (mile 0) to take-out. */
  coords: LatLng[];
  offline?: OfflineInfo;
  /** USGS gauge used for this run, e.g. "USGS-02217770". */
  gaugeId?: string;
  /** Runnable ranges on that gauge. */
  levels?: RouteLevels;
  /** Channels and side branches off the main line (see routeGraph.ts). */
  forks?: RouteFork[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A fork off a route's main line: it leaves at `from` km along the main line
 * and either rejoins it at `rejoin` km (a channel, e.g. around an island) or
 * ends on its own (a side branch, e.g. up a tributary). Its coords start (and,
 * for a channel, end) on the main line.
 */
export interface RouteFork {
  id: string;
  name?: string;
  coords: LatLng[];
  from: number;
  rejoin?: number;
}

/** A feature extracted from OpenStreetMap vector tiles (via OpenFreeMap). */
export interface OsmFeature {
  /** label: a park's name at a point (city parks' outlines carry no name). */
  kind: 'park' | 'path' | 'trail' | 'poi' | 'label';
  /** OpenMapTiles class, e.g. "national_park", "path", "campsite". */
  cls: string;
  sub?: string;
  name?: string;
  /** park: polygon rings · path/trail: line parts · poi: [[point]] */
  geom: LatLng[][];
}

export interface OsmTile {
  /** "z/x/y" */
  key: string;
  fetchedAt: string;
  /** Decoder version that produced `features`; older tiles are re-decoded from `raw`. */
  v?: number;
  /** Original vector tile bytes, kept so decoding improvements don't need a re-download. */
  raw?: ArrayBuffer;
  features: OsmFeature[];
}

export interface CategoryInfo {
  label: string;
  icon: string;
  color: string;
}

export const CATEGORIES: Record<Category, CategoryInfo> = {
  hazard: { label: 'Hazard', icon: '⚠', color: '#c0392b' },
  rapid: { label: 'Rapid', icon: '≋', color: '#e67e22' },
  access: { label: 'Access point', icon: '⛵', color: '#27ae60' },
  parking: { label: 'Parking', icon: 'P', color: '#3949ab' },
  changing: { label: 'Changing room', icon: '👕', color: '#ad1457' },
  campsite: { label: 'Campsite', icon: '⛺', color: '#8e44ad' },
  poi: { label: 'Point of interest', icon: '★', color: '#2980b9' },
  shuttle: { label: 'Shuttle / outfitter', icon: '🚐', color: '#16a085' },
  gauge: { label: 'Gauge', icon: '📈', color: '#7f8c8d' },
  island: { label: 'Island', icon: '🏝', color: '#558b2f' },
  bridge: { label: 'Bridge', icon: '🌉', color: '#6d4c41' },
};

export const SEVERITY_CATEGORIES: Category[] = ['hazard', 'rapid'];

export const ROUTE_COLORS = ['#1565c0', '#d81b60', '#00897b', '#f4511e', '#5e35b1', '#6d4c41'];

/** [lat, lng, time (ms since epoch), accuracy (m) or -1 if unknown] */
export type TrackFix = [number, number, number, number];

export interface Track extends Revisioned {
  id: string;
  name: string;
  /** Ordered by time. */
  fixes: TrackFix[];
  source: 'recorded' | 'gpx';
  /** True while this device is still recording it. */
  recording?: boolean;
  /** Recorded during a trip: the route section paddled (put-in to take-out). */
  trip?: TripInfo;
  createdAt: string;
  updatedAt: string;
}

/** How a photo's location was determined. */
export type PhotoLocSource = 'exif' | 'track' | 'gps' | 'manual';

export interface Photo extends Revisioned {
  id: string;
  /** Attached point, or undefined while it's a draft awaiting review. */
  pointId?: string;
  /** Small JPEG thumbnail (long edge ≤ 240 px). */
  thumb: Blob;
  fileName: string;
  takenAt?: number;
  lat?: number;
  lng?: number;
  locSource?: PhotoLocSource;
  /** For track matches: seconds to the nearest fix used. */
  matchGapSec?: number;
  /** Wide image (2:1 or more), shown scrollable in the viewer. */
  panorama?: boolean;
  /** Camera that took it, e.g. "Google Pixel 8" (from EXIF or Google Photos). */
  camera?: string;
  /** Who took it, when it wasn't you ("Sam"). */
  credit?: string;
  /** Google Photos media item ID, for photos imported from Google Photos. */
  googleId?: string;
  createdAt: string;
}

/** Full-size image, stored separately so listing photos doesn't load every image. */
export interface PhotoBlob {
  id: string;
  /** Resized JPEG (long edge ≤ 1600 px; panoramas: short edge ≤ 1200 px). */
  blob: Blob;
}

/** Walking paths that belong with a river route. */
export type PathKind = 'portage' | 'access';

export interface Portage extends Revisioned {
  id: string;
  name: string;
  kind: PathKind;
  description: string;
  coords: LatLng[];
  /** The river route this belongs to (shared and listed with it). */
  routeId?: string;
  createdAt: string;
  updatedAt: string;
}

export const PATH_KINDS: Record<PathKind, { label: string; icon: string; color: string; hint: string }> = {
  portage: { label: 'Portage', icon: '🛶', color: '#d32f2f', hint: 'Carry around a hazard, dam or rapid' },
  access: { label: 'Access trail', icon: '🥾', color: '#5d4037', hint: 'Walk between parking and the water' },
};

/** USGS parameter codes: discharge (cfs) and gage height (ft). */
export type GaugeParam = '00060' | '00065';

export const GAUGE_PARAMS: Record<GaugeParam, { label: string; unit: string }> = {
  '00060': { label: 'Flow', unit: 'cfs' },
  '00065': { label: 'Stage', unit: 'ft' },
};

export interface GaugeReading {
  value: number;
  /** ISO timestamp of the measurement. */
  time: string;
}

/** A USGS monitoring location with its latest readings, cached for offline use. */
export interface Gauge {
  id: string;
  name: string;
  lat: number;
  lng: number;
  latest: Partial<Record<GaugeParam, GaugeReading>>;
  latestFetchedAt: string;
  /** Last 7 days, [epoch ms, value], oldest first. */
  series?: Partial<Record<GaugeParam, [number, number][]>>;
  seriesFetchedAt?: string;
}

/**
 * Runnable ranges for a route, on one gauge parameter:
 * below `low` = too low, up to `high` = good, above `high` = high, above `flood` = flood.
 */
export interface RouteLevels {
  param: GaugeParam;
  low?: number;
  high?: number;
  flood?: number;
}

/** What a feature from the USACE navigation charts represents. */
export type NavKind = 'sailing-line' | 'mark' | 'danger-mark' | 'restricted' | 'hazard' | 'barge-span';

/** One feature from the USACE Inland Electronic Navigational Charts, trimmed to a route. */
export interface NavFeature {
  kind: NavKind;
  /** Points: one [lat, lng]. Lines: runs of coords. Areas: rings. */
  point?: LatLng;
  lines?: LatLng[][];
  rings?: LatLng[][];
  name?: string;
  info?: string;
  /** e.g. "Red", "Green" for lateral marks. */
  color?: string;
  category?: string;
  clearanceFt?: number;
  widthFt?: number;
}

/** Navigation-chart features along one route, cached for offline use. */
export interface RouteNav {
  routeId: string;
  /** Fingerprint of the route line the data was fetched for. */
  key: string;
  fetchedAt: string;
  features: NavFeature[];
}

/**
 * Synced records carry `_rev`: when and where they were last changed
 * ("2026-11-23T14:03:11.123Z~a1b2c3d4"). The newest revision wins when devices sync.
 */
export interface Revisioned {
  _rev?: string;
}

/** A record deleted on this device, kept for a while so the deletion reaches other devices. */
export interface Tombstone {
  key: string; // "points:<id>"
  store: string;
  id: string;
  rev: string;
}

/** A trip on a route: from a put-in to a take-out, possibly through forks. */
export interface TripInfo {
  routeId: string;
  from: string;
  to: string;
  /** The section's line, put-in to take-out. */
  coords: LatLng[];
  km: number;
}

/** Whether the public may use a piece of land (PAD-US "Pub_Access"). */
export type LandAccess = 'open' | 'restricted' | 'closed' | 'unknown';

/** A piece of public or protected land near a route, from the USGS PAD-US database. */
export interface LandArea {
  name: string;
  /** Who manages it, in words ("Tennessee Valley Authority", "City"). */
  manager: string;
  /** PAD-US manager type code: FED, STAT, LOC, DIST, JNT, NGO, PVT, TRIB, UNK. */
  managerType: string;
  /** PAD-US manager name code, e.g. TVA, NPS, CITY. */
  managerCode: string;
  access: LandAccess;
  /** What kind of place it is ("Local park", "State conservation area"). */
  designation?: string;
  /** Outer rings and holes together (drawn even-odd). */
  rings: LatLng[][];
}

/** Public land along one route, cached for offline use. */
export interface RouteLand {
  routeId: string;
  /** Fingerprint of the route (and forks) the data was fetched for. */
  key: string;
  fetchedAt: string;
  areas: LandArea[];
}
