import { onLocalChange } from '../store';
import { syncOnce, type Remote, type SyncResult } from './engine';

/**
 * When to sync, and telling the rest of the app about it. The actual remote
 * (Google Drive, or a fake one in tests) is plugged in with setRemote().
 */
const DEBOUNCE_MS = 10_000;
const PERIODIC_MS = 5 * 60_000;

export type SyncStatus =
  | { state: 'off' }
  | { state: 'idle'; lastSync?: number; last?: SyncResult }
  | { state: 'syncing' }
  | { state: 'error'; message: string; lastSync?: number };

let remote: Remote | null = null;
let status: SyncStatus = { state: 'off' };
let lastSync: number | undefined;
let running: Promise<void> | null = null;
let again = false;
let timer = 0;
let deviceName: string | undefined;
let onReceived: (() => Promise<void> | void) | null = null;
const statusListeners = new Set<(s: SyncStatus) => void>();

function setStatus(s: SyncStatus) {
  status = s;
  statusListeners.forEach((cb) => cb(s));
}
export const getStatus = () => status;
export function onStatus(cb: (s: SyncStatus) => void) {
  statusListeners.add(cb);
  cb(status);
}

/** Called after records arrive from other devices: reload state and redraw. */
export function setOnReceived(cb: () => Promise<void> | void) {
  onReceived = cb;
}

export function setRemote(r: Remote | null, name?: string) {
  remote = r;
  deviceName = name;
  setStatus(r ? { state: 'idle', lastSync } : { state: 'off' });
  if (r) void syncNow();
}

/** Sync now; if a sync is already running, run once more after it. */
export function syncNow(): Promise<void> {
  if (!remote) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      if (!navigator.onLine) {
        setStatus({ state: 'error', message: 'Offline: will sync when back online', lastSync });
        break;
      }
      setStatus({ state: 'syncing' });
      try {
        const r: Remote = remote!;
        const result = await syncOnce(r, { deviceName });
        if (remote !== r) break; // signed out meanwhile
        lastSync = Date.now();
        if (result.received && onReceived) await onReceived();
        setStatus({ state: 'idle', lastSync, last: result });
        // Photos whose images weren't uploaded yet: look again shortly.
        if (result.pending) schedule(30_000);
      } catch (err) {
        setStatus({ state: 'error', message: (err as Error).message, lastSync });
      }
    } while (again && remote);
  })().finally(() => (running = null));
  return running;
}

function schedule(ms = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), ms);
}

export function initSync() {
  onLocalChange(() => remote && schedule());
  window.addEventListener('online', () => remote && void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && remote && (!lastSync || Date.now() - lastSync > 60_000)) void syncNow();
  });
  setInterval(() => {
    if (remote && document.visibilityState === 'visible') void syncNow();
  }, PERIODIC_MS);
}
