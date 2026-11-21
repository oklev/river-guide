export type Category =
  | 'hazard'
  | 'rapid'
  | 'access'
  | 'campsite'
  | 'poi'
  | 'shuttle'
  | 'gauge';

export type Severity = 'low' | 'medium' | 'high';

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
