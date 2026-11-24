/**
 * Google Cloud project settings for Drive sync and Google Photos import.
 * None of these are secrets: client IDs and (restricted) API keys are meant to
 * ship inside apps. Fill them in from the Google Cloud console (see README:
 * "Setting up Google sync").
 */
export const GOOGLE = {
  /** OAuth client ID of type "Web application". */
  webClientId: '974912635659-58pkcvmld97m534m1nef1s03f3qfe0lu.apps.googleusercontent.com',
  /** API key restricted to the Google Picker API (used to choose shared trip folders). */
  apiKey: 'AIzaSyCUloe17Ue9DTySnSBbTflk7ibBgQG17HQ',
  /** Project number, shown on the Cloud console dashboard (used by the Picker). */
  projectNumber: '974912635659',
};

export const SCOPES = {
  /** Only files this app creates or that you pick with it. */
  drive: 'https://www.googleapis.com/auth/drive.file',
  /** Photos you choose in the Google Photos picker. */
  photosPicker: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
};

export const googleConfigured = () => !!GOOGLE.webClientId;
