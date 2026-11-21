import { WATER_LEVELS, type PointObservation, type RiverPoint, type Severity, type WaterLevel } from './types';

/** Today's local date as YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Parse YYYY-MM-DD as a local date (not UTC, which would shift the day). */
function localDate(ymd: string): Date | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

export const fmtMonth = (ymd?: string) =>
  (ymd && localDate(ymd)?.toLocaleDateString([], { month: 'short', year: 'numeric' })) || '';
export const fmtDay = (ymd?: string) =>
  (ymd && localDate(ymd)?.toLocaleDateString([], { dateStyle: 'medium' })) || '';

const isWaterLevel = (v: unknown): v is WaterLevel => typeof v === 'string' && v in WATER_LEVELS;
const isSeverity = (v: unknown): v is Severity => v === 'low' || v === 'medium' || v === 'high';
const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The point's current observation, as stored on the point itself. */
export function currentObservation(p: RiverPoint): PointObservation {
  return {
    observedAt: p.observedAt,
    description: p.description,
    severity: p.severity,
    waterLevel: p.waterLevel,
    gauge: p.gauge,
    recordedAt: p.updatedAt,
  };
}

const hasContent = (o: PointObservation) => !!(o.description || o.severity || o.waterLevel || o.gauge || o.observedAt);

/** Newest observed first; undated ones go last. */
const byDateDesc = (a: PointObservation, b: PointObservation) =>
  (b.observedAt ?? '').localeCompare(a.observedAt ?? '') || b.recordedAt.localeCompare(a.recordedAt);

/**
 * Store a set of observations on a point: the most recently observed becomes
 * the point's current fields, the rest become its history.
 */
export function setObservations(p: RiverPoint, list: PointObservation[]): RiverPoint {
  const [cur, ...rest] = list.filter(hasContent).sort(byDateDesc);
  return {
    ...p,
    description: cur?.description ?? '',
    severity: cur?.severity,
    observedAt: cur?.observedAt,
    waterLevel: cur?.waterLevel,
    gauge: cur?.gauge,
    history: rest.length ? rest : undefined,
  };
}

/** Replace the current observation (an edit, not a new version). */
export function editCurrent(p: RiverPoint, obs: PointObservation): RiverPoint {
  return setObservations(p, [obs, ...(p.history ?? [])]);
}

/** Add a new dated observation; the previous current one moves into history. */
export function addObservation(p: RiverPoint, obs: PointObservation): RiverPoint {
  return setObservations(p, [obs, currentObservation(p), ...(p.history ?? [])]);
}

export function removeHistory(p: RiverPoint, index: number): RiverPoint {
  const history = (p.history ?? []).filter((_, i) => i !== index);
  return { ...p, history: history.length ? history : undefined };
}

/** "Mar 2026 · High water · 450 cfs" */
export function observationLabel(o: PointObservation, style: 'month' | 'day' = 'month'): string {
  return [
    style === 'day' ? fmtDay(o.observedAt) : fmtMonth(o.observedAt),
    o.waterLevel && WATER_LEVELS[o.waterLevel],
    o.gauge,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Validate observation fields from an imported file. */
export function sanitizeObservation(raw: any): PointObservation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o: PointObservation = {
    observedAt: isYmd(raw.observedAt) ? raw.observedAt : undefined,
    description: typeof raw.description === 'string' ? raw.description : '',
    severity: isSeverity(raw.severity) ? raw.severity : undefined,
    waterLevel: isWaterLevel(raw.waterLevel) ? raw.waterLevel : undefined,
    gauge: typeof raw.gauge === 'string' && raw.gauge ? raw.gauge.slice(0, 200) : undefined,
    recordedAt: typeof raw.recordedAt === 'string' ? raw.recordedAt : new Date().toISOString(),
  };
  return hasContent(o) ? o : null;
}

export { isWaterLevel, isYmd };
