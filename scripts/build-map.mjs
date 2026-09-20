// Shrinks Natural Earth's 110m country outlines into something a single page can load instantly.
// Coordinates go to two decimals (about a kilometre, far finer than the map is drawn) and rings
// smaller than a few pixels at full width are dropped.

import { writeFileSync } from "node:fs";

const SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";

const geo = await (await fetch(SOURCE, { signal: AbortSignal.timeout(120_000) })).json();

const round = (n) => Math.round(n * 100) / 100;

// Shoelace area in square degrees. Good enough to decide what is too small to see.
const area = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
};

const MIN_AREA = 0.6;

const shapes = [];
for (const feature of geo.features) {
  const iso = feature.properties.ISO_A2_EH ?? feature.properties.ISO_A2;
  if (!iso || iso === "-99") continue;
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const rings = [];
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer || area(outer) < MIN_AREA) continue;
    // Drop consecutive duplicates left behind by rounding.
    const simplified = [];
    for (const [lng, lat] of outer) {
      const point = [round(lng), round(lat)];
      const last = simplified[simplified.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) simplified.push(point);
    }
    if (simplified.length >= 4) rings.push(simplified);
  }
  if (rings.length) shapes.push({ iso, rings });
}

const out = new URL("../web/world.json", import.meta.url);
writeFileSync(out, JSON.stringify(shapes), "utf8");
const bytes = JSON.stringify(shapes).length;
console.log(`wrote ${shapes.length} countries, ${(bytes / 1024).toFixed(0)} KB`);
