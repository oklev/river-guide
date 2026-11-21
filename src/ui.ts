export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export const fmtMi = (mi: number) => `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;

/** Short walking distances read better in feet; longer ones in miles. */
export function fmtWalk(km: number): string {
  const ft = km * 3280.84;
  return ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : `${(km / 1.609344).toFixed(2)} mi`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** localStorage wrapper that tolerates private mode / blocked storage. */
export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`river-guide:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`river-guide:${key}`, value);
    } catch {
      /* ignore */
    }
  },
};

export type Mode = 'idle' | 'add-point' | 'route' | 'place';
let mode: Mode = 'idle';
export const getMode = () => mode;
export const setMode = (m: Mode) => {
  mode = m;
  document.getElementById('map')?.classList.toggle('adding', m !== 'idle');
};
