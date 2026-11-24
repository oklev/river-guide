import { openPublicFile, openSharedFile } from './sync/driveOpen';

/**
 * view.html: opens a trip report someone shared through Google Drive.
 *
 * Links look like view.html?id=<Drive file ID>. Drive's "Open with" menu
 * (if set up in the Cloud console) arrives as view.html?state={"ids":[...]}.
 * The report is shown in a sandboxed frame so its scripts can't touch this
 * site's data or the Google sign-in.
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
    const file = await openSharedFile(id, status, 'Select the trip report to open it');
    if (!file) return status('Cancelled.');
    show(await file.blob.text(), file.name);
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
  // Shared with anyone who has the link? Then it opens straight away, no sign-in.
  $('open').hidden = true;
  status('Opening…');
  void openPublicFile(id).then(async (file) => {
    if (file) return show(await file.blob.text(), file.name);
    status('');
    $('open').hidden = false;
  });
}
