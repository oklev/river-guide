export type Category =
  | 'hazard'
  | 'rapid'
  | 'access'
  | 'campsite'
  | 'poi'
  | 'shuttle'
  | 'gauge';

export type Severity = 'low' | 'medium' | 'high';

/** [lat, lng] */
export type LatLng = [number, number];

export interface RiverPoint {
  id: string;
  name: string;
  category: Category;
  description: string;
  lat: number;
  lng: number;
  riverMile?: number;
  severity?: Severity;
  createdAt: string;
  updatedAt: string;
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

export interface Route {
  id: string;
  name: string;
  description: string;
  color: string;
  /** Ordered from put-in (mile 0) to take-out. */
  coords: LatLng[];
  offline?: OfflineInfo;
  createdAt: string;
  updatedAt: string;
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
  campsite: { label: 'Campsite', icon: '⛺', color: '#8e44ad' },
  poi: { label: 'Point of interest', icon: '★', color: '#2980b9' },
  shuttle: { label: 'Shuttle / outfitter', icon: '🚐', color: '#16a085' },
  gauge: { label: 'Gauge', icon: '📈', color: '#7f8c8d' },
};

export const SEVERITY_CATEGORIES: Category[] = ['hazard', 'rapid'];

export const ROUTE_COLORS = ['#1565c0', '#d81b60', '#00897b', '#f4511e', '#5e35b1', '#6d4c41'];
