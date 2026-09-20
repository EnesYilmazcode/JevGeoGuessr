// Builds data/borders.json: full precision country polygons used only to resolve ground truth.
//
// This replaced a Nominatim call per photo. That was one request a second by their fair use policy,
// which capped a 60 photo test set at about forty minutes and made a 500 photo one impossible. The
// same answer comes out of a point in polygon test in microseconds, offline, with no rate limit.
//
// Deliberately NOT the simplified file the replay page draws with: that one rounds coordinates to
// two decimals and drops small islands, which is fine for a picture and wrong for deciding which
// country a point is in.

import { writeFileSync } from "node:fs";

const SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson";
const FALLBACK = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";

let geo;
try {
  geo = await (await fetch(SOURCE, { signal: AbortSignal.timeout(180_000) })).json();
} catch {
  console.log("10m fetch failed, falling back to 50m");
  geo = await (await fetch(FALLBACK, { signal: AbortSignal.timeout(180_000) })).json();
}

const shapes = [];
for (const feature of geo.features) {
  const iso = feature.properties.ISO_A2_EH ?? feature.properties.ISO_A2;
  if (!iso || iso === "-99") continue;
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const polygon of polygons) {
    // [outer ring, ...holes]
    const rings = polygon.map((ring) => ring.map(([lng, lat]) => [Math.round(lng * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4]));
    if (!rings[0] || rings[0].length < 4) continue;
    let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
    for (const [lng, lat] of rings[0]) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    shapes.push({ iso, bbox: [minLng, minLat, maxLng, maxLat], rings });
  }
}

const out = JSON.stringify(shapes);
writeFileSync(new URL("../data/borders.json", import.meta.url), out, "utf8");
console.log(`wrote ${shapes.length} polygons, ${(out.length / 1024 / 1024).toFixed(1)} MB`);
