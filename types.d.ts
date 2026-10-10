// Ambient globals for the browser bundle.

// Leaflet is pulled in from a CDN at runtime (see search.js); no import types.
interface Window {
  L: any
}
