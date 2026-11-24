import { GOOGLE, SCOPES } from './sync/config';
import { getToken } from './sync/googleAuth';

/**
 * sharetest.html: does River Guide's drive.file access work for a folder
 * shared between two Google accounts? Specifically, after the second person
 * picks the shared folder once, can their app
 *   a) list it and read the file the first person's app made,
 *   b) add their own file to it,
 *   c) see files the first person adds *later*, without picking again?
 * And can the first person's app read the second person's file?
 */
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  $('log').textContent = lines.join('\n');
};
const ok = (cond: boolean, what: string, detail = '') => log(`${cond ? '✓' : '✗'} ${what}${detail ? ` (${detail})` : ''}`);

declare const gapi: any;
declare const google: any;

async function token(): Promise<string> {
  return getToken([SCOPES.drive], true);
}

async function api(path: string, init: RequestInit = {}, base = API): Promise<{ status: number; body: any }> {
  const t = await token();
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t}` } });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

async function listFolder(folder: string) {
  const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
  return api(`/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
}

async function createFile(folder: string, name: string, text: string) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name, parents: [folder] })], { type: 'application/json' }));
  form.append('file', new Blob([text], { type: 'text/plain' }), name);
  return api('/files?uploadType=multipart&fields=id,name', { method: 'POST', body: form }, UPLOAD);
}

async function readFile(id: string) {
  const t = await token();
  const res = await fetch(`${API}/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${t}` } });
  return { status: res.status, text: res.ok ? await res.text() : '' };
}

async function checkFolder(folder: string, who: string) {
  const l = await listFolder(folder);
  const names = (l.body?.files ?? []).map((f: any) => f.name);
  ok(l.status === 200, `${who}: list the folder`, l.status === 200 ? `sees ${names.length}: ${names.join(', ') || 'nothing'}` : `error ${l.status}`);
  for (const f of l.body?.files ?? []) {
    const r = await readFile(f.id);
    ok(r.status === 200, `${who}: read "${f.name}"`, r.status === 200 ? JSON.stringify(r.text.slice(0, 40)) : `error ${r.status}`);
  }
  return names as string[];
}

// ---------- the person sharing ----------
let ownerFolder = '';
async function create() {
  const email = $<HTMLInputElement>('email').value.trim();
  if (!email.includes('@')) return alert('Enter their Google account email first.');
  $<HTMLButtonElement>('create').disabled = true;
  try {
    const f = await api('/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'River Guide shared-folder test', mimeType: 'application/vnd.google-apps.folder' }),
    });
    ok(f.status === 200, 'Create the folder', f.status === 200 ? '' : `error ${f.status}`);
    if (f.status !== 200) return;
    ownerFolder = f.body.id;
    const a = await createFile(ownerFolder, 'from-owner-1.txt', 'Written by the first person, before sharing');
    ok(a.status === 200, 'Add a file');
    const p = await api(`/files/${ownerFolder}/permissions?sendNotificationEmail=false&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
    });
    ok(p.status === 200, `Share the folder with ${email} as an editor`, p.status === 200 ? '' : `error ${p.status}: ${p.body?.error?.message ?? ''}`);
    const link = `${location.origin}${location.pathname}?folder=${ownerFolder}`;
    $<HTMLAnchorElement>('share-link').href = link;
    $('share-link').textContent = link;
    $('share-link-box').hidden = false;
    $<HTMLButtonElement>('owner-add').disabled = false;
    $<HTMLButtonElement>('owner-check').disabled = false;
    log('→ Send them the link, and have them do step 2.');
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('create').disabled = false;
  }
}

async function ownerAdd() {
  const r = await createFile(ownerFolder, 'from-owner-2-later.txt', 'Written by the first person AFTER the second person joined');
  ok(r.status === 200, 'Add a new file after they joined');
  log('→ Now have them press "Check again" (step 4).');
}

// ---------- the person it was shared with ----------
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
}

async function pickFolder(folder: string, t: string): Promise<boolean> {
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise<void>((resolve) => gapi.load('picker', { callback: resolve }));
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder');
    if (typeof view.setFileIds === 'function') view.setFileIds(folder);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(t)
      .setDeveloperKey(GOOGLE.apiKey)
      .setAppId(GOOGLE.projectNumber)
      .setTitle('Select the "River Guide shared-folder test" folder')
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) resolve(true);
        else if (data.action === google.picker.Action.CANCEL) resolve(false);
      })
      .build();
    picker.setVisible(true);
  });
}

let memberFolder = '';
async function join() {
  $<HTMLButtonElement>('join').disabled = true;
  try {
    const t = await token();
    log('Before picking the folder:');
    await checkFolder(memberFolder, 'Them');
    log('Picking the folder in Google’s window…');
    const picked = await pickFolder(memberFolder, t);
    ok(picked, 'Folder selected in the picker');
    if (!picked) return;
    log('After picking the folder:');
    await checkFolder(memberFolder, 'Them');
    const w = await createFile(memberFolder, 'from-member.txt', 'Written by the second person');
    ok(w.status === 200, 'Them: add their own file to the folder', w.status === 200 ? '' : `error ${w.status}: ${w.body?.error?.message ?? ''}`);
    $<HTMLButtonElement>('member-check').disabled = false;
    log('→ Tell the first person to do step 3.');
  } catch (err) {
    log(`✗ ${(err as Error).message}`);
  } finally {
    $<HTMLButtonElement>('join').disabled = false;
  }
}

// ---------- wiring ----------
const shared = new URLSearchParams(location.search).get('folder');
if (shared) {
  memberFolder = shared;
  $('owner').hidden = true;
  $('member').hidden = false;
  $('join').addEventListener('click', () => void join());
  $('member-check').addEventListener('click', async () => {
    log('Checking again (did a file added later show up without picking again?):');
    const names = await checkFolder(memberFolder, 'Them');
    ok(names.includes('from-owner-2-later.txt'), 'Them: see the file added after they joined');
  });
} else {
  $('create').addEventListener('click', () => void create());
  $('owner-add').addEventListener('click', () => void ownerAdd());
  $('owner-check').addEventListener('click', async () => {
    const names = await checkFolder(ownerFolder, 'You');
    ok(names.includes('from-member.txt'), "You: see the other person's file");
  });
}
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    alert('Copied. Paste the results to Claude.');
  } catch {
    prompt('Copy these results:', lines.join(' | '));
  }
});
