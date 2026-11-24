import { del, deviceId, get, getAll, put, SYNCED_STORES, type SyncedStore } from '../store';
import type { Photo, Route, Track } from '../types';
import { merge, splitKey, toEntries, toSnapshot, type Entries, type Entry, type Snapshot } from './merge';

/**
 * Syncs this device's data with a shared folder ("remote") that any number of
 * devices read and write. Each device writes only its own snapshot file
 * (device-<id>.json), so devices never overwrite each other; everyone reads
 * everyone's snapshots and merges them (see merge.ts). Photos are stored as
 * separate image files, uploaded once.
 *
 *   device-<id>.json      everything that device knows (records + deletions)
 *   photo-<id>.jpg        full-size photo
 *   thumb-<id>.jpg        thumbnail
 */
export interface RemoteFile {
  id: string;
  name: string;
  /** Changes whenever the file's contents change (Drive's version number, say). */
  version: string;
}

export interface Remote {
  /** Stable name for caching, e.g. the folder ID. */
  key: string;
  list(): Promise<RemoteFile[]>;
  read(file: RemoteFile): Promise<Blob>;
  /** Create the file, or replace it when `existing` is given. */
  write(name: string, data: Blob, type: string, existing?: RemoteFile): Promise<RemoteFile>;
}

export interface SyncResult {
  /** Records added, changed or deleted on this device. */
  received: number;
  /** Photos uploaded. */
  uploaded: number;
  /** Whether this device's snapshot was (re)written. */
  published: boolean;
  /** Records that couldn't be applied yet (e.g. a photo whose image hasn't been uploaded). */
  pending: number;
}

const snapshotName = (device: string) => `device-${device}.json`;
const photoName = (id: string) => `photo-${id}.jpg`;
const thumbName = (id: string) => `thumb-${id}.jpg`;

// ---------- local records <-> entries ----------
/** Fields that only make sense on this device and never sync. */
function toData(store: SyncedStore, rec: Record<string, unknown>): Record<string, unknown> | null {
  const { _rev: _r, ...data } = rec;
  if (store === 'routes') delete (data as Partial<Route>).offline;
  if (store === 'photos') delete (data as Partial<Photo>).thumb;
  if (store === 'tracks' && (rec as unknown as Track).recording) return null; // still being recorded
  return data;
}

export async function loadLocal(): Promise<Entries> {
  const entries: Entries = new Map();
  for (const store of SYNCED_STORES) {
    for (const rec of (await getAll(store)) as unknown as Record<string, unknown>[]) {
      const data = toData(store, rec);
      // Records saved before sync existed have no revision yet: treat them as very old.
      if (data) entries.set(`${store}:${rec.id}`, { rev: (rec._rev as string) ?? '0000~legacy', data });
    }
  }
  for (const t of await getAll('tombstones')) entries.set(t.key, { rev: t.rev });
  return entries;
}

// ---------- applying remote changes ----------
async function applyEntry(remote: Remote, files: Map<string, RemoteFile>, key: string, entry: Entry): Promise<boolean> {
  const [store, id] = splitKey(key) as [SyncedStore, string];
  if (!(SYNCED_STORES as readonly string[]).includes(store)) return true; // from a newer app version: ignore
  if (!entry.data) {
    await del(store, id, { fromSync: true });
    if (store === 'photos') await del('photoBlobs', id, { fromSync: true });
    await put('tombstones', { key, store, id, rev: entry.rev }, { fromSync: true });
    return true;
  }
  const rec: Record<string, unknown> = { ...entry.data, id, _rev: entry.rev };
  const existing = (await get(store, id)) as Record<string, unknown> | undefined;
  if (store === 'routes' && existing?.offline) rec.offline = existing.offline;
  if (store === 'photos') {
    if (existing?.thumb) rec.thumb = existing.thumb;
    else {
      const thumb = files.get(thumbName(id));
      if (!thumb) return false; // uploader hasn't finished yet: try again next sync
      rec.thumb = new Blob([await remote.read(thumb)], { type: 'image/jpeg' });
    }
    if (!(await get('photoBlobs', id))) {
      const full = files.get(photoName(id));
      if (full) await put('photoBlobs', { id, blob: new Blob([await remote.read(full)], { type: 'image/jpeg' }) });
    }
  }
  await put(store, rec as never, { fromSync: true });
  await del('tombstones', key, { fromSync: true });
  return true;
}

// ---------- one sync pass ----------
/** Snapshots already downloaded, by remote + file version, so unchanged ones aren't fetched again. */
const snapshotCache = new Map<string, Snapshot>();
/** What this device last published to each remote, to skip identical uploads. */
const publishedCache = new Map<string, string>();

export async function syncOnce(remote: Remote, opts: { deviceName?: string } = {}): Promise<SyncResult> {
  const me = deviceId();
  const listing = await remote.list();
  const files = new Map(listing.map((f) => [f.name, f]));

  // Everyone else's snapshots (and our own, in case this device's data was wiped).
  const remotes: Entries[] = [];
  for (const f of listing) {
    if (!/^device-.+\.json$/.test(f.name)) continue;
    const cacheKey = `${remote.key}/${f.id}@${f.version}`;
    let snap = snapshotCache.get(cacheKey);
    if (!snap) {
      try {
        snap = JSON.parse(await (await remote.read(f)).text()) as Snapshot;
      } catch {
        continue; // half-written or foreign file: skip
      }
      if (snap?.format !== 1) continue;
      snapshotCache.set(cacheKey, snap);
    }
    remotes.push(toEntries(snap));
  }

  const local = await loadLocal();
  const { merged, changed } = merge(local, remotes);

  let received = 0;
  let pending = 0;
  for (const key of changed) {
    const entry = merged.get(key)!;
    if (await applyEntry(remote, files, key, entry)) received++;
    else {
      pending++;
      // Not applied here, so don't claim it in our snapshot either.
      const mine = local.get(key);
      if (mine) merged.set(key, mine);
      else merged.delete(key);
    }
  }

  // Upload images for photos this device has that the remote doesn't.
  let uploaded = 0;
  for (const [key, entry] of merged) {
    const [store, id] = splitKey(key);
    if (store !== 'photos' || !entry.data) continue;
    const needFull = !files.has(photoName(id));
    const needThumb = !files.has(thumbName(id));
    if (!needFull && !needThumb) continue;
    const photo = (await get('photos', id)) as Photo | undefined;
    if (!photo) continue;
    if (needThumb) await remote.write(thumbName(id), photo.thumb, 'image/jpeg');
    const full = await get('photoBlobs', id);
    if (needFull && full) await remote.write(photoName(id), full.blob, 'image/jpeg');
    uploaded++;
  }

  // Publish our view, unless it's identical to what we last published.
  const snap = toSnapshot(merged, me, opts.deviceName);
  const body = JSON.stringify(snap.entries);
  const ours = files.get(snapshotName(me));
  let published = false;
  if (!ours || publishedCache.get(remote.key) !== body) {
    await remote.write(snapshotName(me), new Blob([JSON.stringify(snap)], { type: 'application/json' }), 'application/json', ours);
    publishedCache.set(remote.key, body);
    published = true;
  }
  return { received, uploaded, published, pending };
}
