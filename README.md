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
- **Offline…** on a route downloads USGS topo map tiles along it. You choose the corridor width (±0.5 km to ±10 km) and the level of detail (zoom 14–16).
- The map reopens at your last view, so after an offline reload it shows your saved area.

**Data**
- GeoJSON import/export covers both points (Point features) and routes (LineString features).

## Map tiles

- **USGS Topo** (default) comes from The National Map. It's public domain and allows offline downloads.
- **OpenStreetMap** is available for online browsing only. OSM's tile usage policy forbids bulk or offline downloading, so the app never pre-downloads OSM tiles.

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
| `src/geo.ts` | Distance, length, project-point-onto-line math |
| `src/store.ts` | IndexedDB persistence |
| `src/geojson.ts` | GeoJSON import/export |

## Roadmap ideas

- Snap traced routes to the actual river channel (NHD flowlines)
- Live USGS gauge readings for gauge points
- Photos on points
- Shared backend so multiple people can edit
