import { registerPlugin } from '@capacitor/core';
import { isNative } from '../platform';
import { prefs } from '../ui';
import { GOOGLE } from './config';

/**
 * Google access tokens for Drive (and the Photos picker).
 *
 * Browser: Google Identity Services' token client (a popup the first time,
 * near-instant afterwards). Android: Google blocks its sign-in page inside
 * app WebViews, so a small native plugin uses Android's own account picker
 * (Google Identity's AuthorizationClient) instead.
 *
 * Tokens last about an hour. Refreshing is silent on Android; in a browser
 * it needs a click if the popup would be blocked, which sync reports as
 * "Tap Sync to reconnect".
 */
interface Token {
  token: string;
  expires: number;
  scopes: string[];
}

interface GoogleAuthPlugin {
  authorize(opts: { scopes: string[]; interactive: boolean }): Promise<{ accessToken: string; email?: string }>;
  signOut(): Promise<void>;
  openUrl(opts: { url: string }): Promise<void>;
}
const NativeAuth = registerPlugin<GoogleAuthPlugin>('GoogleAuth');

export class NeedsUserAction extends Error {
  constructor() {
    super('Tap “Sync now” to reconnect to Google');
  }
}

const KEY = 'googleToken';
let cached: Token | null = null;

function loadCached(): Token | null {
  if (cached) return cached;
  try {
    const t = JSON.parse(sessionStorage.getItem(`river-guide:${KEY}`) ?? 'null') as Token | null;
    if (t && t.expires > Date.now()) cached = t;
  } catch {
    /* ignore */
  }
  return cached;
}

function store(t: Token) {
  cached = t;
  try {
    sessionStorage.setItem(`river-guide:${KEY}`, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

/** Whether the user has connected Google on this device (they may still need to re-authorize). */
export const isSignedIn = () => prefs.get('googleSignedIn') === '1';

// ---------- browser: Google Identity Services ----------
let gisLoaded: Promise<void> | null = null;
function loadGis(): Promise<void> {
  gisLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoaded = null;
      reject(new Error("Couldn't load Google sign-in (offline?)"));
    };
    document.head.appendChild(s);
  });
  return gisLoaded;
}

declare const google: any;

async function webToken(scopes: string[], interactive: boolean): Promise<Token> {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE.webClientId,
      scope: scopes.join(' '),
      // Previously consented: no account chooser, the popup closes by itself.
      prompt: interactive && !isSignedIn() ? 'consent' : '',
      callback: (r: any) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        resolve({ token: r.access_token, expires: Date.now() + (Number(r.expires_in) - 60) * 1000, scopes });
      },
      error_callback: (e: any) => reject(e?.type === 'popup_failed_to_open' ? new NeedsUserAction() : new Error(e?.message || 'Sign-in cancelled')),
    });
    client.requestAccessToken();
  });
}

// ---------- Android: native ----------
async function nativeToken(scopes: string[], interactive: boolean): Promise<Token> {
  try {
    const r = await NativeAuth.authorize({ scopes, interactive });
    return { token: r.accessToken, expires: Date.now() + 50 * 60_000, scopes };
  } catch (err) {
    if (!interactive && /NEEDS_USER_ACTION|resolution/i.test((err as Error).message)) throw new NeedsUserAction();
    throw err;
  }
}

/**
 * An access token covering `scopes`. With `interactive`, may show Google's
 * sign-in/consent UI (call from a click). Without, fails with NeedsUserAction
 * when the user has to be involved.
 */
export async function getToken(scopes: string[], interactive = false): Promise<string> {
  const t = loadCached();
  if (t && t.expires > Date.now() && scopes.every((s) => t.scopes.includes(s))) return t.token;
  const all = [...new Set([...(t?.scopes ?? []), ...scopes])];
  if (!interactive && !isSignedIn()) throw new NeedsUserAction();
  // Browser, no click: a popup is usually blocked (error_callback -> NeedsUserAction), but
  // right after a click it goes through, so it's still worth trying.
  const fresh = isNative ? await nativeToken(all, interactive) : await webToken(all, interactive);
  store(fresh);
  prefs.set('googleSignedIn', '1');
  return fresh.token;
}

export async function signOut() {
  const t = loadCached();
  cached = null;
  try {
    sessionStorage.removeItem(`river-guide:${KEY}`);
  } catch {
    /* ignore */
  }
  prefs.set('googleSignedIn', '0');
  if (isNative) await NativeAuth.signOut().catch(() => {});
  else if (t && typeof google !== 'undefined') google.accounts.oauth2.revoke?.(t.token, () => {});
}

/** Android: open a Google page outside the app (WebViews can't open new windows). */
export const openExternal = (url: string) => NativeAuth.openUrl({ url });

/** Forget a token Google rejected (expired or revoked early). */
export function dropToken() {
  cached = null;
  try {
    sessionStorage.removeItem(`river-guide:${KEY}`);
  } catch {
    /* ignore */
  }
}
