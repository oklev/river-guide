import type { Photo } from '../types';

/** Deciding which photos picked in Google Photos to import (no browser APIs, so it can be unit-tested). */
/** A Google Photos picker item (the fields we use). */
export interface PickedItem {
  id: string;
  createTime: string;
  type?: string;
  mediaFile: {
    baseUrl: string;
    mimeType?: string;
    filename?: string;
    mediaFileMetadata?: { width?: number; height?: number; cameraMake?: string; cameraModel?: string };
  };
}

export interface TripWindow {
  start: number;
  end: number;
  label: string;
}

/** Photos taken this long before/after a trip's GPS track still belong to it. */
const TRIP_SLACK_MS = 20 * 60_000;

/**
 * Is this picked photo already in River Guide? Matches an earlier Google Photos
 * import by ID, or a photo from the camera roll / a file by file name (the
 * original name survives Google Photos backup) or by an identical capture time.
 */
export function isDuplicate(item: PickedItem, existing: Photo[]): boolean {
  const t = Date.parse(item.createTime);
  const name = item.mediaFile.filename?.toLowerCase();
  return existing.some((p) => {
    if (p.googleId) return p.googleId === item.id;
    if (p.takenAt == null || !Number.isFinite(t)) return false;
    const dt = Math.abs(p.takenAt - t);
    // EXIF times without a time zone can be off by whole hours; a matching name is enough then.
    if (name && p.fileName.toLowerCase() === name && dt < 26 * 3_600_000) return true;
    return dt < 1500;
  });
}

export function classify(items: PickedItem[], existing: Photo[], trip?: TripWindow) {
  const fresh: PickedItem[] = [];
  let duplicates = 0;
  let outside = 0;
  let videos = 0;
  for (const m of items) {
    const t = Date.parse(m.createTime);
    if (m.type === 'VIDEO' || !m.mediaFile?.baseUrl) videos++;
    else if (isDuplicate(m, existing)) duplicates++;
    else if (trip && !(t >= trip.start - TRIP_SLACK_MS && t <= trip.end + TRIP_SLACK_MS)) outside++;
    else fresh.push(m);
  }
  return { fresh, duplicates, outside, videos };
}
