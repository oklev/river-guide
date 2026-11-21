import L from 'leaflet';
import { lengthKm } from './geo';
import type { LatLng } from './types';
import { $, fmtMi, setMode } from './ui';

type DoneCallback = (coords: LatLng[] | null) => void;

export interface EditorOptions {
  /** Shown until the line has two points. */
  hint?: string;
  /** Formats the line's length (km) for the toolbar. */
  format?: (km: number) => string;
  dashArray?: string;
}

const vertexIcon = (color: string, first: boolean) =>
  L.divIcon({
    className: '',
    html: `<div class="vertex${first ? ' first' : ''}" style="--pin:${color}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
const midpointIcon = L.divIcon({ className: '', html: '<div class="midpoint"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });

/**
 * Interactive polyline editor: tap the map to extend the line, drag vertices to
 * move them, tap a vertex to delete it, drag/tap a midpoint handle to insert one.
 */
export class RouteEditor {
  private coords: L.LatLng[] = [];
  private color = '#1565c0';
  private onDone: DoneCallback | null = null;
  private opts: EditorOptions = {};
  private readonly line = L.polyline([], { weight: 4, dashArray: '8 6', interactive: false });
  private readonly handles = L.layerGroup();

  constructor(private readonly map: L.Map) {
    $('route-undo').addEventListener('click', () => this.undo());
    $('route-cancel').addEventListener('click', () => this.end(null));
    $('route-finish').addEventListener('click', () => this.finish());
  }

  get active() {
    return this.onDone !== null;
  }

  start(initial: LatLng[], color: string, onDone: DoneCallback, opts: EditorOptions = {}) {
    if (this.active) this.end(null);
    this.opts = opts;
    this.coords = initial.map(([lat, lng]) => L.latLng(lat, lng));
    this.color = color;
    this.onDone = onDone;
    this.line.setStyle({ color, dashArray: opts.dashArray ?? '8 6' }).addTo(this.map);
    this.handles.addTo(this.map);
    this.map.on('click', this.onMapClick);
    this.map.closePopup();
    setMode('route');
    $('route-toolbar').hidden = false;
    this.redraw();
  }

  private onMapClick = (e: L.LeafletMouseEvent) => {
    this.coords.push(e.latlng);
    this.redraw();
  };

  private undo() {
    this.coords.pop();
    this.redraw();
  }

  private finish() {
    if (this.coords.length < 2) {
      alert('A route needs at least two points. Tap along the river to trace it.');
      return;
    }
    this.end(this.coords.map((c) => [c.lat, c.lng] as LatLng));
  }

  private end(result: LatLng[] | null) {
    const cb = this.onDone;
    this.onDone = null;
    this.map.off('click', this.onMapClick);
    this.line.remove();
    this.handles.clearLayers().remove();
    $('route-toolbar').hidden = true;
    setMode('idle');
    cb?.(result);
  }

  private redraw() {
    this.line.setLatLngs(this.coords);
    this.handles.clearLayers();
    this.coords.forEach((ll, i) => {
      const m = L.marker(ll, { icon: vertexIcon(this.color, i === 0), draggable: true, keyboard: false });
      m.on('drag', () => {
        this.coords[i] = m.getLatLng();
        this.line.setLatLngs(this.coords);
      });
      m.on('dragend', () => this.redraw());
      m.on('click', () => {
        this.coords.splice(i, 1);
        this.redraw();
      });
      this.handles.addLayer(m);
    });
    for (let i = 1; i < this.coords.length; i++) {
      const a = this.coords[i - 1];
      const b = this.coords[i];
      const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      const m = L.marker(mid, { icon: midpointIcon, draggable: true, keyboard: false, opacity: 0.8 });
      m.on('dragend', () => {
        this.coords.splice(i, 0, m.getLatLng());
        this.redraw();
      });
      m.on('click', () => {
        this.coords.splice(i, 0, mid);
        this.redraw();
      });
      this.handles.addLayer(m);
    }
    const n = this.coords.length;
    const km = lengthKm(this.coords.map((c) => [c.lat, c.lng]));
    const fmt = this.opts.format ?? ((k: number) => fmtMi(k / 1.609344));
    $('route-status').textContent = n < 2 ? (this.opts.hint ?? 'Tap the map at the put-in, then along the river') : `${n} points · ${fmt(km)}`;
  }
}
