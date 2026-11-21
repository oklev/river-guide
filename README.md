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

**Data**
- GeoJSON import/export covers both points (Point features) and routes (LineString features).

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
