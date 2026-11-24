import { $, prefs } from '../ui';

/**
 * "Who took these?" for imported photos, shown with the photos themselves.
 *
 * Photos are grouped by camera. A camera you've named is credited
 * automatically next time, unless you left some of its photos out (two people
 * with the same phone model): then River Guide keeps asking for that camera.
 */
export interface CreditItem {
  id: string;
  /** Loads a small preview image URL (object URL or data URL). */
  thumb: () => Promise<string>;
}

interface Memory {
  /** camera -> name ("" = you) */
  names: Record<string, string>;
  /** cameras shared by several people: always ask */
  ask: string[];
  /** names used before, offered as suggestions */
  people: string[];
}

const KEY = 'cameraCredits2';

function load(): Memory {
  try {
    const m = JSON.parse(prefs.get(KEY) ?? 'null');
    if (m && typeof m.names === 'object' && Array.isArray(m.ask)) return { people: [], ...m };
  } catch {
    /* ignore */
  }
  // Older versions stored just { camera: name }.
  try {
    const old = JSON.parse(prefs.get('cameraCredits') ?? '{}');
    if (old && typeof old === 'object') return { names: old, ask: [], people: [] };
  } catch {
    /* ignore */
  }
  return { names: {}, ask: [], people: [] };
}
const save = (m: Memory) => prefs.set(KEY, JSON.stringify(m));

/** One round of the dialog. Resolves with the chosen photos and name, or null for Skip. */
function askOnce(
  camera: string | undefined,
  items: CreditItem[],
  knownNames: string[],
  canRemember: boolean,
): Promise<{ ids: string[]; name: string; remember: boolean } | null> {
  const dialog = $<HTMLDialogElement>('credit-dialog');
  const n = items.length;
  $('credit-camera').textContent = camera
    ? `${n} photo${n === 1 ? '' : 's'} from a ${camera}.`
    : `${n} photo${n === 1 ? '' : 's'} without camera details.`;
  $('credit-hint').hidden = n < 2;
  const name = $<HTMLInputElement>('credit-name');
  name.value = '';
  $('credit-names').innerHTML = knownNames.map((v) => `<option value="${v.replace(/"/g, '&quot;')}"></option>`).join('');
  const remember = $<HTMLInputElement>('credit-remember');
  remember.checked = canRemember;
  remember.closest('label')!.hidden = !camera;
  $('credit-remember-label').textContent = canRemember
    ? 'Remember this for photos from this camera'
    : 'Remember this camera (not recommended: more than one person uses this phone model)';

  const box = $('credit-thumbs');
  box.innerHTML = '';
  const urls: string[] = [];
  const buttons = items.map((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'true');
    b.title = 'Tap to leave out';
    const img = document.createElement('img');
    img.alt = '';
    b.append(img);
    void it.thumb().then(
      (url) => {
        urls.push(url);
        img.src = url;
      },
      () => {},
    );
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      // Leaving photos out means more than one person has this phone: don't assume next time.
      if (!on) remember.checked = false;
    });
    box.append(b);
    return b;
  });

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        for (const u of urls) if (u.startsWith('blob:')) URL.revokeObjectURL(u);
        if (dialog.returnValue !== 'ok') return resolve(null);
        const ids = items.filter((_, i) => buttons[i].getAttribute('aria-pressed') === 'true').map((it) => it.id);
        resolve({ ids, name: name.value.trim(), remember: remember.checked });
      },
      { once: true },
    );
    dialog.returnValue = '';
    dialog.showModal();
    name.focus();
  });
}

/**
 * Work out credits for imported photos. `groups` maps a camera name (or "" for
 * unknown) to its photos. Returns photo ID -> name, for photos not taken by you.
 */
export async function askCredits(groups: Map<string, CreditItem[]>): Promise<Map<string, string>> {
  const memory = load();
  const credits = new Map<string, string>();
  const knownNames = () => [...new Set([...memory.people, ...Object.values(memory.names)].filter(Boolean))].sort();

  for (const [camera, items] of groups) {
    const shared = memory.ask.includes(camera);
    if (camera && !shared && camera in memory.names) {
      const name = memory.names[camera];
      if (name) for (const it of items) credits.set(it.id, name);
      continue;
    }
    let remaining = items;
    while (remaining.length) {
      // Re-read each round: leaving photos out marks the camera as shared from then on.
      const canRemember = !memory.ask.includes(camera);
      const answer = await askOnce(camera || undefined, remaining, knownNames(), canRemember);
      if (!answer || !answer.ids.length) break; // skipped: leave these uncredited
      if (answer.name) {
        for (const id of answer.ids) credits.set(id, answer.name);
        if (!memory.people.includes(answer.name)) memory.people.push(answer.name);
      }
      const leftOut = remaining.filter((it) => !answer.ids.includes(it.id));
      if (camera) {
        if (answer.remember && !leftOut.length) {
          memory.names[camera] = answer.name;
          memory.ask = memory.ask.filter((c) => c !== camera);
        } else if (leftOut.length || !answer.remember) {
          if (!memory.ask.includes(camera)) memory.ask.push(camera);
          delete memory.names[camera];
        }
      }
      save(memory);
      remaining = leftOut;
    }
  }
  return credits;
}
