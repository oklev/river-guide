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

export interface OfflineInfo {
  bufferKm: number;
  maxZoom: number;
  tiles: number;
  failed: number;
  downloadedAt: string;
  /** Route line was edited after the download, so the saved area may not cover it. */
  stale?: boolean;
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
