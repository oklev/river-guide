import { isNative } from '../platform';
import { $, prefs } from '../ui';
import { getStatus, onStatus, setRemote, syncNow, type SyncStatus } from './index';
import { googleConfigured, SCOPES } from './config';
import { DriveFolder, findOrCreateFolder } from './drive';
import { getToken, isSignedIn, NeedsUserAction, signOut } from './googleAuth';

/** Sidebar "Sync" section: connect Google Drive, show status, sync now. */
const FOLDER_NAME = 'River Guide';

function deviceName(): string {
  if (isNative) return 'Android app';
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function ago(t?: number): string {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function render(s: SyncStatus = getStatus()) {
  const connected = s.state !== 'off';
  $('sync-connect').hidden = connected || !googleConfigured();
  $('sync-now').hidden = !connected;
  $('sync-disconnect').hidden = !connected;
  const el = $('sync-status');
  el.classList.toggle('sync-error', s.state === 'error');
  el.textContent = !googleConfigured()
    ? "Google Drive sync isn't set up for this copy of the app yet."
    : s.state === 'off'
      ? 'Keep your points, routes, tracks and photos in sync between devices through your Google Drive.'
      : s.state === 'syncing'
        ? 'Syncing…'
        : s.state === 'error'
          ? s.message
          : `Synced ${ago(s.lastSync)}${s.last?.received ? ` · ${s.last.received} update${s.last.received === 1 ? '' : 's'} received` : ''}`;
}

async function connect() {
  const btn = $<HTMLButtonElement>('sync-connect');
  btn.disabled = true;
  try {
    await getToken([SCOPES.drive], true);
    const folder = await findOrCreateFolder(FOLDER_NAME, true);
    prefs.set('driveFolder', folder);
    setRemote(new DriveFolder(folder), deviceName());
  } catch (err) {
    alert(`Couldn't connect to Google Drive: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

async function manualSync() {
  try {
    // From a click, so Google may show its popup/account picker if it needs to.
    await getToken([SCOPES.drive], true);
  } catch (err) {
    if (!(err instanceof NeedsUserAction)) return alert(`Couldn't reach Google: ${(err as Error).message}`);
  }
  await syncNow();
}

async function disconnect() {
  if (!confirm('Stop syncing this device? Your data stays here and in Google Drive.')) return;
  setRemote(null);
  prefs.set('driveFolder', '');
  await signOut();
}

export function initSyncUi() {
  $('sync-connect').addEventListener('click', () => void connect());
  $('sync-now').addEventListener('click', () => void manualSync());
  $('sync-disconnect').addEventListener('click', () => void disconnect());
  onStatus(render);
  setInterval(() => getStatus().state === 'idle' && render(), 30_000); // keep "x min ago" fresh

  const folder = prefs.get('driveFolder');
  if (googleConfigured() && isSignedIn() && folder) setRemote(new DriveFolder(folder), deviceName());

  // Tests drive sync with a fake remote.
  if (import.meta.env.DEV) {
    void Promise.all([import('../store'), import('../state')]).then(([store, { state }]) =>
      Object.assign(window, { __rgSync: { setRemote, syncNow, getStatus, store, state } }),
    );
  }
}
