# River Guide

A paddling map where you can create and edit your own river data: hazards, rapids, access points, campsites, shuttles, gauges, points of interest, and routes. It works offline. It's inspired by the Georgia River Guide app, but here the data is editable.

## Features

**Points**
- Add a point by tapping the map, then set its name, category, severity (hazards and rapids), river mile and description.
- Drag markers to reposition them.
- **From route** fills in a point's river mile from the nearest route line.
- The sidebar lists points sorted by river mile, with search and category filters.

**Routes**
- Trace a run by tapping along the river from put-in (mile 0) to take-out.
- Edit the line afterwards: drag vertices, tap a vertex to remove it, drag a midpoint handle to add a bend. ⇄ swaps put-in and take-out.
- Each route's popup lists the points within 0.5 km of the line, in river-mile order (a quick trip sheet).

**Offline**
- The app is an installable PWA, and a service worker caches the app shell.
- Points and routes live in IndexedDB, so they're always available offline.
- **Offline…** on a route downloads USGS topo map tiles along it. You choose the corridor width (±0.5 km river corridor by default, up to ±10 km) and the level of detail (zoom 14–16).
- **Delete offline data** in the same dialog frees a route's storage. Tiles shared with other saved routes are kept. Deleting a route also deletes its offline data.
- The map reopens at your last view, so after an offline reload it shows your saved area.

**Trails, parks & campsites overlay**
- When you save a route offline, the app can also save OpenStreetMap data for the same corridor. This is on by default.
- The data shows as a layer you can toggle: shaded parks (city parks as well as national, state and protected areas) with name labels, footpaths and tracks (tap a named trail to see its name), and icons for campsites, shelters, marinas, viewpoints, restrooms and drinking water.
- Parking inside parks or within 300 m of a route shows from zoom 14. Other parking appears at zoom 16.
- The overlay is trimmed to the corridors you saved. The underlying data tiles are about 2 km wide, so without trimming a narrow corridor would still show features up to 2 km away.
- Raw data tiles are stored alongside the decoded features, so decoding improvements apply without re-downloading.
- **Add as my point** in an icon's popup turns that feature into one of your own editable points.
- It works anywhere OpenStreetMap has coverage, not just Georgia, because only the area around your routes is downloaded.

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
| `src/store.ts` | IndexedDB persistence |
| `src/geojson.ts` | GeoJSON import/export |

## Roadmap ideas

- Snap traced routes to the actual river channel (NHD flowlines)
- Live USGS gauge readings for gauge points
- Photos on points
- Shared backend so multiple people can edit
- Read original photo GPS on Android via a native picker (ACCESS_MEDIA_LOCATION) when the WebView picker strips it
