import { importFile } from '../share';
import { isNative } from '../platform';
import { $ } from '../ui';
import { googleConfigured } from './config';
import { openPublicFile, openSharedFile } from './driveOpen';
import { onAppLink } from './googleAuth';

/**
 * Importing a route someone shared through Google Drive.
 *
 * Browser: the link is <web app>?import=<Drive file ID>.
 * Android app: riverguide://import?id=<Drive file ID>, which Android browsers
 * can hand to the app ("Open in the River Guide app").
 */
const ANDROID_PACKAGE = 'io.github.oklev.riverguide';
let pendingId: string | null = null;
/** The file, if it's shared with anyone with the link (checked as soon as the prompt shows). */
let publicFile: Promise<{ blob: Blob; name?: string } | null> = Promise.resolve(null);
let publicResult: { blob: Blob; name?: string } | null | undefined;

const dialog = () => $<HTMLDialogElement>('import-dialog');
const step = (m: string) => ($('import-status').textContent = m);

/** Take ?import= off the address so a reload doesn't ask again. */
function clearParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has('import')) return;
  url.searchParams.delete('import');
  history.replaceState(null, '', url.toString());
}

function ask(id: string) {
  pendingId = id;
  step('');
  // Check now, not on the tap: Google's sign-in popup has to open straight from the tap.
  publicResult = undefined;
  publicFile = openPublicFile(id).then((f) => (publicResult = f));
  // In an Android browser, offer to open the app instead (falls back to this page if it isn't installed).
  const inAndroidBrowser = !isNative && /Android/i.test(navigator.userAgent);
  const inApp = $<HTMLAnchorElement>('import-in-app');
  inApp.hidden = !inAndroidBrowser;
  if (inAndroidBrowser) {
    const back = encodeURIComponent(location.href);
    inApp.href = `intent://import?id=${encodeURIComponent(id)}#Intent;scheme=riverguide;package=${ANDROID_PACKAGE};S.browser_fallback_url=${back};end`;
  }
  if (!dialog().open) dialog().showModal();
}

async function doImport() {
  const id = pendingId;
  if (!id) return;
  const btn = $<HTMLButtonElement>('import-go');
  btn.disabled = true;
  try {
    // Public links need no sign-in; otherwise sign in with the account it was shared with.
    const file =
      publicResult === undefined
        ? ((await publicFile) ?? (await openSharedFile(id, step, 'Select the shared route to import it')))
        : (publicResult ?? (await openSharedFile(id, step, 'Select the shared route to import it')));
    if (!file) return step('Cancelled.');
    step('Importing…');
    dialog().close();
    clearParam();
    pendingId = null;
    await importFile(new File([file.blob], file.name ?? 'shared.riverguide.zip'));
  } catch (err) {
    step(`Couldn't import: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

/** Call after the app's data has loaded. */
export function initSharedImport() {
  $('import-go').addEventListener('click', () => void doImport());
  $('import-later').addEventListener('click', () => {
    dialog().close();
    clearParam();
  });
  if (!googleConfigured()) return;
  const id = new URLSearchParams(location.search).get('import');
  if (id) ask(id);
  if (isNative) {
    void onAppLink((url) => {
      try {
        const u = new URL(url);
        const linkId = u.searchParams.get('id');
        if (u.host === 'import' && linkId) ask(linkId);
      } catch {
        /* not a link we know */
      }
    });
  }
}
