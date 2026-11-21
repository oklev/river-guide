import { Capacitor } from '@capacitor/core';

/** True inside the Android app; false in a regular browser. */
export const isNative = Capacitor.isNativePlatform();

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
