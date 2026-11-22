import { openDB, type IDBPDatabase } from 'idb';
import type { Gauge, OsmTile, Photo, PhotoBlob, Portage, RiverPoint, Route, RouteNav, Track } from './types';

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
}
type StoreName = keyof Stores;

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
};
const DB_VERSION = 7;

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

export async function put<S extends StoreName>(store: S, value: Stores[S]): Promise<void> {
  await (await db()).put(store, value);
}

export async function del(store: StoreName, id: string): Promise<void> {
  await (await db()).delete(store, id);
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

export async function putMany<S extends StoreName>(store: S, values: Stores[S][]): Promise<void> {
  const tx = (await db()).transaction(store, 'readwrite');
  await Promise.all([...values.map((v) => tx.store.put(v)), tx.done]);
}
