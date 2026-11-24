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

**Data & sharing**
- **Share…** on a route saves it as one `.riverguide.zip` file: the route, your points within a chosen distance of it, their photos, and optionally your GPS tracks along it. Offline maps aren't included; they can be downloaded again. Inside is a standard `route.geojson` plus a `photos/` folder.
- **Import file** accepts `.riverguide.zip` and plain GeoJSON. Items are matched by ID and the newer copy wins, so moving data back and forth between devices doesn't duplicate anything or overwrite newer edits. Each device keeps its own offline downloads.
- **Export GeoJSON** saves all points, routes and tracks, without photos, as a backup.

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
| `src/nav.ts` | Navigation-channel layer from USACE inland charts |
| `src/store.ts` | IndexedDB persistence |
| `src/geojson.ts` | GeoJSON import/export |

## Roadmap ideas

- Snap traced routes to the actual river channel (NHD flowlines)
- Shared backend so multiple people can edit
