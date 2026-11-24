import { GOOGLE, SCOPES } from './config';
import { getToken } from './googleAuth';

/**
 * Opening a file someone shared with you through Google Drive (a trip report
 * or a route package). River Guide only has drive.file access, so the first
 * time a person opens a shared file Google's picker shows just that file and
 * they confirm it; after that it opens directly.
 */
const API = 'https://www.googleapis.com/drive/v3';

declare const gapi: any;
declare const google: any;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
}

/** Google's file picker, showing just this file, so the person can grant River Guide access to it. */
async function confirmWithPicker(id: string, token: string, title: string): Promise<boolean> {
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise<void>((resolve) => gapi.load('picker', { callback: resolve }));
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
    if (typeof view.setFileIds === 'function') view.setFileIds(id);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(GOOGLE.apiKey)
      .setAppId(GOOGLE.projectNumber)
      .setTitle(title)
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) resolve(true);
        else if (data.action === google.picker.Action.CANCEL) resolve(false);
      })
      .build();
    picker.setVisible(true);
  });
}

async function download(id: string, token: string): Promise<{ ok: true; blob: Blob; name?: string } | { ok: false; status: number }> {
  const res = await fetch(`${API}/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false, status: res.status };
  const meta = await fetch(`${API}/files/${id}?fields=name`, { headers: { Authorization: `Bearer ${token}` } });
  const name = meta.ok ? (await meta.json()).name : undefined;
  return { ok: true, blob: await res.blob(), name };
}

/**
 * A file shared as "anyone with the link" can be read with the project's API
 * key, no sign-in needed. Returns null if it isn't public (or the key can't
 * be used for Drive).
 */
export async function openPublicFile(id: string): Promise<{ blob: Blob; name?: string } | null> {
  if (!GOOGLE.apiKey) return null;
  try {
    const key = encodeURIComponent(GOOGLE.apiKey);
    const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media&key=${key}`);
    if (!res.ok) return null;
    const meta = await fetch(`${API}/files/${encodeURIComponent(id)}?fields=name&key=${key}`);
    return { blob: await res.blob(), name: meta.ok ? (await meta.json()).name : undefined };
  } catch {
    return null;
  }
}

export class NotShared extends Error {
  constructor() {
    super("This wasn't shared with the Google account you signed in with, or it was deleted.");
  }
}

/**
 * Sign in (call from a tap), then download a shared file, asking the person to
 * confirm it in Google's picker if River Guide hasn't opened it for them before.
 * Resolves null if they cancel the picker.
 */
export async function openSharedFile(
  id: string,
  onStep: (msg: string) => void = () => {},
  pickerTitle = 'Select the shared file to open it',
): Promise<{ blob: Blob; name?: string } | null> {
  onStep('Signing in…');
  const token = await getToken([SCOPES.drive], true);
  onStep('Opening…');
  let r = await download(id, token);
  if (!r.ok && (r.status === 404 || r.status === 403)) {
    onStep('Select the file in the Google window to open it.');
    if (!(await confirmWithPicker(id, token, pickerTitle))) return null;
    r = await download(id, token);
  }
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) throw new NotShared();
    throw new Error(`Google Drive error ${r.status}`);
  }
  return { blob: r.blob, name: r.name };
}
