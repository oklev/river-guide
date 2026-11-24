import { GOOGLE, SCOPES } from './sync/config';
import { downloadText } from './sync/drive';
import { getToken } from './sync/googleAuth';

/**
 * view.html: opens a trip report someone shared through Google Drive.
 *
 * Links look like view.html?id=<Drive file ID>. Drive's "Open with" menu
 * (if set up in the Cloud console) arrives as view.html?state={"ids":[...]}.
 *
 * River Guide only has drive.file access, so the first time a person opens
 * a report Google's file picker shows just that file and they confirm it;
 * after that the report opens straight away. The report is shown in a
 * sandboxed frame so its scripts can't touch this site's data.
 */
const $ = (id: string) => document.getElementById(id)!;
const status = (s: string) => ($('status').textContent = s);

function fileId(): string | null {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (id) return id;
  try {
    const state = JSON.parse(params.get('state') ?? 'null');
    return state?.ids?.[0] ?? state?.exportIds?.[0] ?? null;
  } catch {
    return null;
  }
}

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
async function confirmWithPicker(id: string, token: string): Promise<boolean> {
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise<void>((resolve) => gapi.load('picker', { callback: resolve }));
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
    if (typeof view.setFileIds === 'function') view.setFileIds(id);
    else view.setMimeTypes('text/html');
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(GOOGLE.apiKey)
      .setAppId(GOOGLE.projectNumber)
      .setTitle('Select the trip report to open it')
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) resolve(true);
        else if (data.action === google.picker.Action.CANCEL) resolve(false);
      })
      .build();
    picker.setVisible(true);
  });
}

function show(html: string, name?: string) {
  const frame = $('report') as HTMLIFrameElement;
  frame.srcdoc = html;
  frame.hidden = false;
  $('card').hidden = true;
  document.title = `${(name ?? 'Trip report').replace(/\.html?$/i, '').replace(/[-_]+/g, ' ')} · River Guide`;
}

async function open(id: string) {
  const btn = $('open') as HTMLButtonElement;
  btn.disabled = true;
  try {
    status('Signing in…');
    const token = await getToken([SCOPES.drive], true);
    status('Opening the report…');
    let r = await downloadText(id);
    if (!r.ok && (r.status === 404 || r.status === 403)) {
      // Not opened with River Guide before: confirm it in Google's picker.
      status('Select the report in the Google window to open it.');
      if (!(await confirmWithPicker(id, token))) {
        status('Cancelled.');
        return;
      }
      r = await downloadText(id);
    }
    if (!r.ok) {
      status(
        r.status === 404 || r.status === 403
          ? "This report wasn't shared with the Google account you signed in with, or it was deleted."
          : `Couldn't open the report (error ${r.status}).`,
      );
      return;
    }
    show(r.text, r.name);
  } catch (err) {
    status(`Couldn't open the report: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

const id = fileId();
if (!id) {
  $('message').textContent = "This link doesn't point to a trip report.";
  $('open').hidden = true;
} else {
  // Opening needs a tap: browsers only allow Google's sign-in window from one.
  $('open').addEventListener('click', () => void open(id));
}
