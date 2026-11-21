// exifr's "lite" build (JPEG/HEIC, EXIF + GPS) has no type declarations of its own.
declare module 'exifr/dist/lite.esm.mjs' {
  import exifr from 'exifr';
  export default exifr;
}
