import { Capacitor } from '@capacitor/core';

/** True inside the Android app; false in a regular browser. */
export const isNative = Capacitor.isNativePlatform();

/**
 * Hand a generated file (GeoJSON, GPX…) to the user. Browsers download it;
 * the Android app's WebView can't, so there we write it to the cache and
 * open the share sheet (save to Files/Drive, send, etc.).
 */
export async function saveFile(fileName: string, content: string, mime: string): Promise<void> {
  if (!isNative) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const { uri } = await Filesystem.writeFile({
    path: fileName,
    data: content,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  await Share.share({ title: fileName, files: [uri] });
}
