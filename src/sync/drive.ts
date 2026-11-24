import type { Remote, RemoteFile } from './engine';
import { SCOPES } from './config';
import { dropToken, getToken } from './googleAuth';

/**
 * A Google Drive folder as a sync remote. Uses the narrow drive.file scope:
 * the app only sees files it created, or folders/files the user picked with it.
 */
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,version';

async function call(url: string, init: RequestInit = {}, interactive = false): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken([SCOPES.drive], interactive);
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401 && attempt === 0) {
      dropToken(); // expired early: get a new one and retry once
      continue;
    }
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = (await res.json())?.error?.message ?? msg;
      } catch {
        /* ignore */
      }
      throw new Error(`Google Drive: ${msg}`);
    }
    return res;
  }
  throw new Error('Google Drive: not authorized');
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Find (or create) a folder by name at the top of My Drive, among folders this app made. */
export async function findOrCreateFolder(name: string, interactive = false): Promise<string> {
  const query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents`;
  const found = await (await call(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, {}, interactive)).json();
  if (found.files?.[0]?.id) return found.files[0].id;
  const created = await (
    await call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    })
  ).json();
  return created.id;
}

export async function createFolder(name: string, parent?: string): Promise<string> {
  const created = await (
    await call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) }),
    })
  ).json();
  return created.id;
}

export class DriveFolder implements Remote {
  readonly key: string;
  constructor(readonly folderId: string) {
    this.key = `drive:${folderId}`;
  }

  async list(): Promise<RemoteFile[]> {
    const out: RemoteFile[] = [];
    let page = '';
    do {
      const query = encodeURIComponent(`'${q(this.folderId)}' in parents and trashed=false`);
      const r = await (
        await call(`${API}/files?q=${query}&fields=nextPageToken,files(${FIELDS})&pageSize=1000${page ? `&pageToken=${page}` : ''}`)
      ).json();
      for (const f of r.files ?? []) out.push({ id: f.id, name: f.name, version: String(f.version) });
      page = r.nextPageToken ?? '';
    } while (page);
    return out;
  }

  async read(file: RemoteFile): Promise<Blob> {
    return (await call(`${API}/files/${file.id}?alt=media`)).blob();
  }

  async write(name: string, data: Blob, type: string, existing?: RemoteFile): Promise<RemoteFile> {
    let r;
    if (existing) {
      r = await call(`${UPLOAD}/files/${existing.id}?uploadType=media&fields=${FIELDS}`, {
        method: 'PATCH',
        headers: { 'Content-Type': type },
        body: data,
      });
    } else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name, parents: [this.folderId] })], { type: 'application/json' }));
      form.append('file', data, name);
      r = await call(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', body: form });
    }
    const f = await r.json();
    return { id: f.id, name: f.name, version: String(f.version) };
  }
}

// ---------- reports: upload any size, share ----------
/** A folder inside another one (created if missing). */
export async function findOrCreateChildFolder(parent: string, name: string): Promise<string> {
  const query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and trashed=false and '${q(parent)}' in parents`;
  const found = await (await call(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`)).json();
  return found.files?.[0]?.id ?? createFolder(name, parent);
}

/** Upload a file of any size (simple uploads stop at 5 MB; reports with photos can be bigger). */
export async function uploadLarge(name: string, data: Blob, type: string, parent: string): Promise<string> {
  const start = await call(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
    body: JSON.stringify({ name, parents: [parent], mimeType: type }),
  });
  const session = start.headers.get('Location');
  if (!session) throw new Error('Google Drive: no upload session');
  const res = await fetch(session, { method: 'PUT', headers: { 'Content-Type': type }, body: data });
  if (!res.ok) throw new Error(`Google Drive upload: ${res.status}`);
  return (await res.json()).id;
}

/** Let someone view a file; Google emails them, with `message` in the email. */
export async function shareWith(fileId: string, email: string, message: string): Promise<void> {
  const params = new URLSearchParams({ sendNotificationEmail: 'true', emailMessage: message, fields: 'id' });
  await call(`${API}/files/${fileId}/permissions?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: email }),
  });
}
