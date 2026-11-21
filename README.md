# River Guide

A paddling map where you can create and edit your own river data: hazards, rapids, access points, campsites, shuttles, gauges and points of interest. It's inspired by the Georgia River Guide app, but here the data is editable.

## Features (v0.1)

- Full-screen map (OpenStreetMap tiles) centered on Georgia
- Add points by tapping the map; edit name, category, severity (hazards/rapids), river mile and description
- Drag markers to reposition them
- Sidebar list sorted by river mile, with search and category filters
- Data saved locally in the browser (IndexedDB)
- GeoJSON import/export for backup and sharing
- "Locate me" button

## Development

Requires Node.js 20+.

```sh
npm install
npm run dev      # start dev server
npm run build    # typecheck + production build
```

## Roadmap ideas

- River/trail lines (draw routes, auto-compute river mileage)
- Offline map tiles + installable PWA
- Live USGS gauge readings for gauge points
- Photos on points
- Shared backend so multiple people can edit
