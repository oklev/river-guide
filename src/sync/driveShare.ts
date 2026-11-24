import { prefs } from '../ui';
import { SCOPES } from './config';
import { getToken } from './googleAuth';
import { findOrCreateChildFolder, findOrCreateFolder, shareWith, uploadLarge } from './drive';

/**
 * Saving something to "River Guide › <folder>" in your Google Drive and
 * sharing it with people by email (trip reports, route packages).
 */
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** "a@x.com, b@y.org" -> addresses, or the ones that don't look like email addresses. */
export function parseEmails(text: string): { emails: string[]; bad: string[] } {
  const all = text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  return { emails: all.filter((e) => EMAIL.test(e)), bad: all.filter((e) => !EMAIL.test(e)) };
}

/** Make sure we can talk to Drive; call from a tap (may show Google's sign-in). */
export const connectDrive = () => getToken([SCOPES.drive], true);

export async function saveAndShare(opts: {
  folder: string;
  name: string;
  data: Blob;
  type: string;
  emails: string[];
  /** The link people get, from the new file's ID. */
  link: (id: string) => string;
  /** First line of Google's email, e.g. "Route: Downtown Chattanooga". */
  subject: string;
  onStep?: (msg: string) => void;
}): Promise<string> {
  const step = opts.onStep ?? (() => {});
  step('Saving to Google Drive…');
  const root = prefs.get('driveFolder') || (await findOrCreateFolder('River Guide'));
  const folder = await findOrCreateChildFolder(root, opts.folder);
  const id = await uploadLarge(opts.name, opts.data, opts.type, folder);
  const link = opts.link(id);
  for (const [i, email] of opts.emails.entries()) {
    step(`Sharing with ${email} (${i + 1} of ${opts.emails.length})…`);
    await shareWith(id, email, [opts.subject, '', `Open it here: ${link}`].join('\n'));
  }
  return link;
}

export async function copyLink(link: string, onDone: (msg: string) => void) {
  try {
    await navigator.clipboard.writeText(link);
    onDone('Link copied.');
  } catch {
    prompt('Copy this link:', link);
  }
}
