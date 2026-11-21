import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.oklev.riverguide',
  appName: 'River Guide',
  webDir: 'dist',
  android: {
    // Required by the background-geolocation plugin: without it, location
    // updates halt after ~5 minutes in the background.
    useLegacyBridge: true,
  },
};

export default config;
