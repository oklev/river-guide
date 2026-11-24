# River Guide

A paddling map where you can create and edit your own river data: hazards, rapids, access points, campsites, shuttles, gauges, points of interest, and routes. It works offline. It's inspired by the Georgia River Guide app, but here the data is editable.

## Features

**Points**
- Add a point by tapping the map, then set its name, category, severity (hazards and rapids), river mile and description.
- **Observations:** conditions change with season and water level, so each point keeps dated observations. Each observation has the date seen, water level (low/normal/high/flood), an optional gauge reading, severity and description. **Edit** fixes the current one; **+ New observation** (or **Save as new observation** in the editor) records a new one and moves the previous one into history. The most recently observed is always shown as current, so backfilling an older trip doesn't replace it. Popups show the current observation, earlier ones and when the point was last updated.
- Drag markers to reposition them.
- **From route** fills in a point's river mile from the nearest route line.
- The sidebar lists points sorted by river mile, with search and category filters.

**Routes**
- Trace a run by tapping along the river from put-in (mile 0) to take-out.
- Edit the line afterwards: drag vertices, tap a vertex to remove it, drag a midpoint handle to add a bend. ⇄ swaps put-in and take-out.
- Each route's popup lists the points within 0.5 km of the line, in river-mile order (a quick trip sheet).
- **Portages and access trails** are dotted walking paths drawn the same way as routes, in feet: red for carrying around a hazard or dam, brown for walking between parking and the water. Each one attaches to the nearest route (changeable), appears in that route's popup at its river mile, and is included when the route is shared. Deleting a route keeps its paths but detaches them.

**Your location**
- A live marker follows you while the app is open: a pulsing blue dot, or a **kayak, paddleboard or canoe** (choose in the sidebar under "Show my location as"). It turns to point the way you're heading, from the GPS's own heading when moving or worked out from your last few metres. A faint circle shows the GPS accuracy.
- ◎ centers the map on you. The marker appears by itself on startup if location is already allowed (it never prompts), and the GPS is only used while the app is on screen.

**Offline**
- The app is an installable PWA, and a service worker caches the app shell.
- Points and routes live in IndexedDB, so they're always available offline.
- **Offline…** on a route downloads USGS topo map tiles along it. You choose the corridor width (±0.5 km river corridor by default, up to ±10 km) and the level of detail (zoom 14–16).
- **Delete offline data** in the same dialog frees a route's storage. Tiles shared with other saved routes are kept. Deleting a route also deletes its offline data.
- The map reopens at your last view, so after an offline reload it shows your saved area.

**Live river gauges (USGS)**
- Gauges near your routes, and in the map view when zoomed in, show as markers with the latest flow (cfs) or stage (ft). Tapping one shows flow and stage with their trend (rising, falling or steady), a 7-day graph, and a link to the USGS page.
- Each route can use a gauge (the nearest one on the river is suggested) and a **runnable range**: too low below X, high above Y, flood above Z. The route popup and list then show current conditions, for example "57 cfs ↘ · Good", and gauge markers are coloured by level.
- **Observations:** "From gauge" fills in the gauge reading. It uses the latest value for today, or the daily mean for a past date. If the route has ranges, it also sets the water level. New observations made today are pre-filled automatically when a recent reading exists.
- The last readings are cached, so offline they still show with their time ("Last reading: 3:00 PM · offline"). Gauges that haven't reported in the past 7 days are hidden, unless a route uses them.
- Data comes from the [USGS Water Data APIs](https://api.waterdata.usgs.gov) (OGC API; no key needed). The legacy waterservices.usgs.gov API isn't used because it shuts down in early 2027.

**Navigation channel (USACE charts)**
- On big commercial rivers (Tennessee, Cumberland, Ohio, Mississippi and so on), each route shows the **barge sailing line** (purple dashes), red and green **channel markers**, **restricted areas** (such as the water above and below dams), charted **hazards** (obstructions, rocks and wrecks) and the **bridge spans barges use** (purple). Tap any of them for an explanation.
- It's fetched automatically for every route when you're online, refreshed monthly or when you edit the line, and saved so it works offline. It's only a few KB per route.
- Data comes from the US Army Corps of Engineers' [Inland Electronic Navigational Charts](https://ienccloud.us/) (public, no key). Small rivers aren't charted, so nothing is shown there. Charts can be out of date, so on the water the actual buoys take priority.

**Trails, parks & campsites overlay**
- When you save a route offline, the app can also save OpenStreetMap data for the same corridor. This is on by default.
- The data shows as a layer you can toggle: shaded parks (city parks as well as national, state and protected areas) with name labels, footpaths and tracks (tap a named trail to see its name), and icons for campsites, shelters, marinas, viewpoints, restrooms and drinking water.
- Parking inside parks or within 300 m of a route shows from zoom 14. Other parking appears at zoom 16.
- The overlay is trimmed to the corridors you saved. The underlying data tiles are about 2 km wide, so without trimming a narrow corridor would still show features up to 2 km away.
- Raw data tiles are stored alongside the decoded features, so decoding improvements apply without re-downloading.
- **Add as my point** in an icon's popup turns that feature into one of your own editable points.
- It works anywhere OpenStreetMap has coverage, not just Georgia, because only the area around your routes is downloaded.

**Photos**
- **Import photos** (Points tab) turns pictures into draft points. Each is located from its own GPS tag, matched by time to a recorded GPS track, or placed by hand, then reviewed: make a point, move it, or discard it.
- **Photo sessions (Android app):** the 📷 button opens your phone's own camera app, so you get its panorama, zoom and night modes, and photos save to your camera roll as usual. Every photo taken since the session started is pulled into River Guide each time you switch back, located from its GPS tag, your track, or your current position. A banner shows the count, with **Camera** to shoot more and **End** to finish. Needs "Allow all" photo access, since limited access hides new photos.
- In a browser, 📷 takes a single photo and tags it with your current position.
- **Panoramas** (2:1 or wider) are kept at higher resolution and open full-height in the viewer, where you swipe to look around.

**Sync between devices (Google Drive)**
- **Connect Google Drive** in the sidebar on each device. Points, routes, tracks, portages/trails and photos then stay in sync through a "River Guide" folder in your Drive. Gauges, navigation charts and offline maps aren't synced; each device fetches its own.
- Syncs when the app opens, about 10 s after a change, when you're back online, every 5 minutes while open, and with **Sync now**.
- If two devices change the same item, the newer change wins. Deletions sync too (they're remembered for 90 days).
- How it works: each device writes only its own `device-<id>.json` snapshot (so devices never overwrite each other) and reads everyone else's; photos are separate `photo-<id>.jpg` / `thumb-<id>.jpg` files uploaded once. The app only has access to files it creates (Drive's `drive.file` scope).
- **From Google Photos** (Tracks tab) imports photos chosen in Google's photo picker. Google strips their GPS, so they're matched to a recorded track by time or placed by hand. Friends' photos from a shared album land in the right place as long as *you* recorded the track.
  - Pick freely: photos already in River Guide are skipped before downloading (same Google Photos item, same file name, or same capture time).
  - **Add Google Photos** on a track's popup keeps only photos taken during that trip (±20 min).
  - Photos are credited by camera: the first time a new phone's photos arrive, River Guide shows them and asks who took them (blank = you), and remembers it. If two people have the same phone model, tap the photos the other person took to leave them out; you're asked about those next, and that camera is asked about every time from then on. Credits show on the photo and in trip reports.
- Needs a Google Cloud project; see "Setting up Google sync" below.

**Data & sharing**
- **Share…** on a route saves it as one `.riverguide.zip` file: the route, your points within a chosen distance of it, their photos, and optionally your GPS tracks along it. Offline maps aren't included; they can be downloaded again. Inside is a standard `route.geojson` plus a `photos/` folder.
- **Save to Google Drive** in the same dialog puts the package in "River Guide › Shared routes" and shares it with email addresses. Google emails them a link (`/app/?import=<file ID>`) that opens River Guide with an Import prompt; the first time, Google's file picker shows just that file to confirm. Tick **Anyone with the link** to skip the sign-in entirely: the file is made viewable by anyone who has the link (not listed or searchable), and reports open / routes import straight away using the project's API key. In an Android browser the prompt also offers **Open in the app**, which hands the link to the River Guide app (`riverguide://import?id=…`).
- **Import file** accepts `.riverguide.zip` and plain GeoJSON. Items are matched by ID and the newer copy wins, so moving data back and forth between devices doesn't duplicate anything or overwrite newer edits. Each device keeps its own offline downloads.
- **Export GeoJSON** saves all points, routes and tracks, without photos, as a backup.
- **Trip report…** (on a route's or a track's popup) opens a dialog to set the title and description, choose which GPS tracks and photos to include, turn features on or off (points, stats, speed colours, sun, legend), and adjust the planned route's line for that report only (the saved route isn't changed). Your photo, track and feature choices are remembered per route on that device, so the next report starts from them (**Suggested** goes back to River Guide's picks for the photos). It saves one self-contained web page of the trip to your device, or with **Save to Google Drive** to "River Guide › Trip reports" in your Drive, optionally shared with email addresses. Google emails them a link to the report viewer (`/app/view.html?id=…`), which opens it in their browser after they sign in with that Google account; the first time, Google's file picker shows just that report to confirm, because the app only has per-file Drive access. Reports open in a sandboxed frame. The page shows: the map with your GPS track and the planned route, stats (distance, time on the water, average speed) and a timeline of the photos you took and the points you passed, with times and river miles. Tap an entry to jump the map to it; photos open full size and panoramas scroll. The GPS track is split wherever your pace changed and coloured by speed (relative to the trip, purple slow to yellow fast, grey for stops); hover a section for its speed, duration and distance. Hovering along the track also scrolls the timeline to that part of the trip, and a strip above the map shows the sun's path during the trip over a wavy water line, with the time left until sunset. Distances and speeds ignore GPS jitter (measured between fixes 30 s apart). Anything before the first Access point the track passes, or after the last (e.g. driving to the put-in), is drawn thin and dashed, isn't coloured, and is left out of the stats, start/finish times and sun strip. The scroll wheel zooms the map while the pointer is over it. Photos and the map library are embedded, so it opens in any browser and can be sent to anyone (only the background map tiles need internet). By default it picks your most recent track along the route and the photos taken during it; without a track it lists the route's points and photos by river mile.

## Map tiles

- **USGS Topo** (default) comes from The National Map. It's public domain and allows offline downloads.
- **OpenStreetMap** is available for online browsing only. OSM's tile usage policy forbids bulk or offline downloading, so the app never pre-downloads OSM tiles.
- **Trails and parks** come from [OpenFreeMap](https://openfreemap.org) vector tiles (OpenStreetMap data, OpenMapTiles schema).
  - The app fetches zoom-14 tiles only, decodes them in the browser, and stores the extracted features in IndexedDB.
  - It stays within OpenFreeMap's [offline download terms](https://openfreemap.org/tos/): at most 3,000 tiles or 50 MB per download, and at most 4 parallel requests.
  - We don't use public Overpass API servers, which have been unreliable.
  - OpenMapTiles has no boat ramps, put-ins, rapids or dams, so those stay as your own points.

## Development

Requires Node.js 20+.

```sh
npm install
npm run dev      # dev server (service worker disabled in dev)
npm run build    # typecheck + production build
npm run preview  # serve the production build, with service worker, on localhost
```

Offline storage (Cache Storage, service worker) only works on `https://` or `localhost`. To test on a phone, deploy to an https host instead of opening the dev server by LAN IP.

### Android app

The same web code is wrapped with [Capacitor](https://capacitorjs.com). On Android, track recording uses a foreground location service (the `@capacitor-community/background-geolocation` plugin), so it keeps working with the screen off. A notification shows while it's recording.

You need JDK 21 and the Android SDK (platform 36, build-tools 36.1). Android Studio isn't required. Point `android/local.properties` at the SDK (`sdk.dir=C\:/Users/<you>/AppData/Local/Android/Sdk`) and set `JAVA_HOME` to the JDK, then run:

```sh
npm run build:android                        # web build (no service worker) + cap sync
cd android && ./gradlew assembleDebug        # → android/app/build/outputs/apk/debug/app-debug.apk
```

Install the APK by copying it to the phone and opening it (allow "Install unknown apps"), or with `adb install -r app-debug.apk` over USB debugging.

### Releases

Pushing a version tag builds a signed APK in GitHub Actions and publishes it as a GitHub release ([.github/workflows/android-release.yml](.github/workflows/android-release.yml)):

```sh
npm version 0.6.0 --no-git-tag-version   # bump package.json; the app's versionCode is derived from it
git commit -am "Release v0.6.0" && git tag v0.6.0 && git push && git push --tags
```

- The tag must match `package.json`.
- The workflow needs two repository secrets: `ANDROID_KEYSTORE_BASE64` (the release keystore, base64-encoded) and `ANDROID_KEYSTORE_PASSWORD`.
- Locally, Gradle reads the key from `~/.android/river-guide-release/keystore.properties`. With that file present, debug builds are signed with the same key, so they install over released versions.
- **Back up the keystore.** Android only accepts updates signed with the same key. If the key is lost, the only way to install a new version is to uninstall the app, which deletes its data.

## Code layout

| File | Purpose |
| --- | --- |
| `src/main.ts` | Boot, sidebar tabs, import/export, geolocation |
| `src/map.ts` | Leaflet map, base layers, saved view |
| `src/points.ts` | Point markers, list, filters, editor |
| `src/routes.ts` | Route lines, list, popups, details dialog, offline download dialog |
| `src/routeEditor.ts` | Interactive polyline drawing and editing |
| `src/tiles.ts` | Offline-aware tile layer, corridor tile planning, downloader |
| `src/osm.ts` | OpenFreeMap vector tile download and decoding into trail/park/POI features |
| `src/osmLayer.ts` | Renders the trails, parks & campsites overlay |
| `src/geo.ts` | Distance, length, project-point-onto-line math |
| `src/cameraRoll.ts` | Android photo sessions (camera app + camera-roll import) |
| `src/myLocation.ts` | Live "you are here" marker (dot or boat icon) |
| `view.html`, `src/viewer.ts` | Viewer for trip reports shared through Google Drive |
| `src/sync/driveShare.ts`, `driveOpen.ts`, `sharedImport.ts` | Sharing reports and routes through Drive, and opening/importing shared ones |
| `src/sync/` | Device sync: merge logic, engine, Google Drive remote, Google sign-in, Photos picker |
| `src/tripReport.ts`, `src/tripReportTemplate.ts`, `src/reportDialog.ts` | Trip report: options dialog and self-contained HTML export |
| `src/nav.ts` | Navigation-channel layer from USACE inland charts |
| `src/store.ts` | IndexedDB persistence |
| `src/geojson.ts` | GeoJSON import/export |

## Roadmap ideas

- Snap traced routes to the actual river channel (NHD flowlines)
- Shared backend so multiple people can edit

## Website

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes to GitHub Pages on every push to `main` (Settings → Pages → Source: GitHub Actions):

- [oklev.github.io/river-guide](https://oklev.github.io/river-guide/): homepage and [privacy policy](https://oklev.github.io/river-guide/privacy.html), from `site/`
- [oklev.github.io/river-guide/app](https://oklev.github.io/river-guide/app/): the web app, installable as a PWA

## Setting up Google sync

Drive sync and the Google Photos import need a (free) Google Cloud project, registered under your own Google account. One-time, about 15 minutes:

1. **Create a project:** [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate), name it "River Guide", and select it.
2. **Enable APIs** ([API Library](https://console.cloud.google.com/apis/library)): **Google Drive API**, **Google Picker API** and **Photos Picker API**.
3. **Consent screen** ([Google Auth Platform](https://console.cloud.google.com/auth/overview) → Get started): app name "River Guide", your email for support and contact, audience **External**. Then on **Branding**: homepage `https://oklev.github.io/river-guide/`, privacy policy `https://oklev.github.io/river-guide/privacy.html`, authorized domain `oklev.github.io`.
4. **Data access** → Add or remove scopes → add these by hand, then Save:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`
5. **Audience** → **Publish app**, so the status is **In production**. (In "Testing", Google signs you out every 7 days.)
6. **Clients** → Create client → **Web application**: authorized JavaScript origins `https://oklev.github.io` (the hosted app) and `http://localhost:5173` (`npm run dev`). Copy the **Client ID**.
7. **Clients** → Create client → **Android**: package name `io.github.oklev.riverguide`, SHA-1 `1D:13:C1:BD:9E:2E:7C:92:BA:B4:C0:E3:78:C9:9E:19:3B:4E:84:51` (the release signing key, which also signs debug builds).
8. **API key** ([Credentials](https://console.cloud.google.com/apis/credentials) → Create credentials → API key): restrict it to the **Google Picker API** and **Google Drive API** (Drive is for opening "anyone with the link" shares without signing in), and to websites `https://oklev.github.io/*`, `http://localhost:5173/*` and `https://localhost/*` (the Android app). Copy the key.
9. Put the Client ID, API key and **project number** (on the project dashboard) in `src/sync/config.ts`.

None of these values are secrets: client IDs and restricted API keys are designed to ship inside apps.
