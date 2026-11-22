import { Capacitor, SystemBars, SystemBarsStyle, SystemBarType } from '@capacitor/core';

/** True inside the Android app; false in a regular browser. */
export const isNative = Capacitor.isNativePlatform();

/**
 * On newer Android WebViews the app is drawn edge-to-edge and the top bar's
 * colour extends behind the status bar (see --safe-top in style.css). Make the
 * clock/battery icons contrast with it: light icons on the dark teal bar, dark
 * icons on the light teal bar used in dark mode.
 */
export function initSystemBars() {
  if (!isNative) return;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  let last = '';
  const apply = () => {
    const bar = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 0;
    const edgeToEdge = bar > 53; // taller than the bar itself means it's padded for the status bar
    const style = !edgeToEdge ? SystemBarsStyle.Default : dark.matches ? SystemBarsStyle.Light : SystemBarsStyle.Dark;
    if (style === last) return;
    last = style;
    void SystemBars.setStyle({ style, bar: SystemBarType.StatusBar }).catch(() => {});
  };
  apply();
  // Capacitor injects the inset values shortly after load; re-check on changes.
  window.addEventListener('resize', apply);
  dark.addEventListener('change', apply);
  setTimeout(apply, 1000);
}

/**
 * Hand a generated file (GeoJSON, GPX…) to the user. Browsers download it;
 * the Android app's WebView can't, so there we write it to the cache and
 * open the share sheet (save to Files/Drive, send, etc.).
 */
export async function saveFile(fileName: string, content: string | Blob, mime: string): Promise<void> {
  if (!isNative) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: mime }));
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const { uri } =
    typeof content === 'string'
      ? await Filesystem.writeFile({ path: fileName, data: content, directory: Directory.Cache, encoding: Encoding.UTF8 })
      : // Binary files are passed to the native side as base64.
        await Filesystem.writeFile({ path: fileName, data: await blobToBase64(content), directory: Directory.Cache });
  await Share.share({ title: fileName, files: [uri] });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
