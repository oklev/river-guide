import { openDB, type IDBPDatabase } from 'idb';
import type { Gauge, OsmTile, Photo, PhotoBlob, Portage, RiverPoint, Route, RouteLand, RouteNav, Tombstone, Track } from './types';

const DB_NAME = 'river-guide';

interface Stores {
  points: RiverPoint;
  routes: Route;
  osm: OsmTile;
  tracks: Track;
  photos: Photo;
  photoBlobs: PhotoBlob;
  portages: Portage;
  gauges: Gauge;
  nav: RouteNav;
  land: RouteLand;
  tombstones: Tombstone;
}
export type StoreName = keyof Stores;

/** Stores whose records sync between devices (see sync/). */
export const SYNCED_STORES = ['points', 'routes', 'tracks', 'portages', 'photos'] as const;
export type SyncedStore = (typeof SYNCED_STORES)[number];
const isSynced = (s: StoreName): s is SyncedStore => (SYNCED_STORES as readonly string[]).includes(s);

/** Every object store and its key. Adding a store means adding it here and bumping DB_VERSION. */
const STORES: Record<StoreName, string> = {
  points: 'id',
  routes: 'id',
  osm: 'key',
  tracks: 'id',
  photos: 'id',
  photoBlobs: 'id',
  portages: 'id',
  gauges: 'id',
  nav: 'routeId',
  land: 'routeId',
  tombstones: 'key',
};
const DB_VERSION = 9;

let dbPromise: Promise<IDBPDatabase> | null = null;

function open(version?: number): Promise<IDBPDatabase> {
  return openDB(DB_NAME, version, {
    // Create whatever is missing rather than going by version number, so a
    // database that somehow ended up without a store gets repaired too.
    upgrade(database) {
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath });
      }
    },
    // Another tab running an older version is holding the database open, so the
    // upgrade (and every read/write) waits. Say so instead of hanging silently.
    blocked() {
      alert('River Guide was updated. Close any other River Guide tabs (or reload them) to finish updating.');
    },
    // A newer version opened in another tab: let it upgrade, and reload this one.
    blocking() {
      void dbPromise?.then((d) => d.close());
      dbPromise = null;
      if (confirm('River Guide was updated in another tab. Reload this tab now?')) location.reload();
    },
    terminated() {
      dbPromise = null;
    },
  });
}

async function openChecked(): Promise<IDBPDatabase> {
  let d: IDBPDatabase;
  try {
    d = await open(DB_VERSION);
  } catch (err) {
    // Stored at a higher version than this code knows (e.g. after a repair): open as-is.
    if ((err as DOMException).name !== 'VersionError') throw err;
    d = await open();
  }
  const missing = Object.keys(STORES).filter((n) => !d.objectStoreNames.contains(n));
  if (missing.length) {
    console.warn(`River Guide: database v${d.version} is missing ${missing.join(', ')}; repairing.`);
    const next = d.version + 1;
    d.close();
    d = await open(next);
  }
  return d;
}

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openChecked().catch((err) => {
    dbPromise = null; // let the next call try again
    throw err;
  });
  return dbPromise;
}

export async function getAll<S extends StoreName>(store: S): Promise<Stores[S][]> {
  return (await db()).getAll(store);
}

// ---------- change tracking for sync ----------
/** A short random ID for this device/browser, used to break ties between revisions. */
export function deviceId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem('river-guide:deviceId');
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      localStorage.setItem('river-guide:deviceId', id);
    }
  } catch {
    /* private mode: a fresh ID per session is fine */
  }
  return (id ??= crypto.randomUUID().slice(0, 8));
}

/** Revisions sort by time, then device: "2026-11-23T14:03:11.123Z~a1b2c3d4". */
export const newRev = () => `${new Date().toISOString()}~${deviceId()}`;

interface WriteOpts {
  /** Written by sync with a revision from elsewhere: keep it, don't record a local change. */
  fromSync?: boolean;
}

const changeListeners = new Set<() => void>();
/** Called after any local (non-sync) change to synced data. */
export function onLocalChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}
const notify = () => changeListeners.forEach((cb) => cb());

export async function put<S extends StoreName>(store: S, value: Stores[S], opts: WriteOpts = {}): Promise<void> {
  const d = await db();
  if (isSynced(store) && !opts.fromSync) {
    (value as { _rev?: string })._rev = newRev();
    await d.put(store, value);
    await d.delete('tombstones', `${store}:${(value as { id: string }).id}`); // re-created after a delete
    notify();
    return;
  }
  await d.put(store, value);
}

export async function del(store: StoreName, id: string, opts: WriteOpts = {}): Promise<void> {
  const d = await db();
  await d.delete(store, id);
  if (isSynced(store) && !opts.fromSync) {
    await d.put('tombstones', { key: `${store}:${id}`, store, id, rev: newRev() });
    notify();
  }
}

export async function get<S extends StoreName>(store: S, key: string): Promise<Stores[S] | undefined> {
  return (await db()).get(store, key);
}

export async function hasKey(store: StoreName, key: string): Promise<boolean> {
  return (await (await db()).getKey(store, key)) !== undefined;
}

export async function clearStore(store: StoreName): Promise<void> {
  await (await db()).clear(store);
}

export async function count(store: StoreName): Promise<number> {
  return (await db()).count(store);
}

export async function putMany<S extends StoreName>(store: S, values: Stores[S][], opts: WriteOpts = {}): Promise<void> {
  const stamp = isSynced(store) && !opts.fromSync;
  if (stamp) for (const v of values) (v as { _rev?: string })._rev = newRev();
  const tx = (await db()).transaction(store, 'readwrite');
  await Promise.all([...values.map((v) => tx.store.put(v)), tx.done]);
  if (stamp && values.length) notify();
}
