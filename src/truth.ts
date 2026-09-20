// Ground truth: which country a photo's coordinates actually fall in.
// Only the benchmark touches this. It is never shown to the describer or to Jev.
//
// Resolved offline by point in polygon against Natural Earth borders. The earlier version asked
// Nominatim, which is one request a second under their fair use policy, and that single call was
// what made a large test set impractical. Nominatim is still here as a cross-check.

import { readFileSync, existsSync } from "node:fs";

type Shape = { iso: string; bbox: [number, number, number, number]; rings: [number, number][][] };

const BORDERS = new URL("../data/borders.json", import.meta.url);

let shapes: Shape[] | null = null;
function borders(): Shape[] {
  if (shapes) return shapes;
  if (!existsSync(BORDERS)) throw new Error("data/borders.json missing. Run: node scripts/build-borders.mjs");
  shapes = JSON.parse(readFileSync(BORDERS, "utf8")) as Shape[];
  return shapes;
}

// Ray casting. Returns true when the point is inside the ring.
function inRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hit(lat: number, lng: number): string | null {
  for (const shape of borders()) {
    const [minLng, minLat, maxLng, maxLat] = shape.bbox;
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
    const [outer, ...holes] = shape.rings;
    if (!outer || !inRing(lng, lat, outer)) continue;
    if (holes.some((hole) => inRing(lng, lat, hole))) continue; // enclave carved out of this one
    return shape.iso;
  }
  return null;
}

/**
 * ISO 3166-1 alpha-2 for a coordinate, or null when it falls outside every country.
 *
 * Coastlines are generalised, so a seafront road often lands a hair offshore and misses every
 * polygon. Auditing against Nominatim, that was the only way this disagreed: never a wrong country,
 * just a null for a coastal town. When the point misses, look a short way around it and accept the
 * answer only if every hit agrees, so a photo taken on a border still resolves to null rather than
 * to a coin flip.
 */
export function countryCodeAtOffline(lat: number, lng: number): string | null {
  const direct = hit(lat, lng);
  if (direct) return direct;

  for (const step of [0.01, 0.03, 0.08]) {
    const found = new Set<string>();
    for (const [dLat, dLng] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]] as const) {
      const near = hit(lat + dLat, lng + dLng);
      if (near) found.add(near);
    }
    if (found.size === 1) return [...found][0]!;
    if (found.size > 1) return null; // offshore between two countries, not worth guessing
  }
  return null;
}

/**
 * How far the point sits from the nearest border of the country it is in, in degrees.
 * A photo a few metres from a frontier is not a fair test of anything, so the sampler drops them.
 */
export function marginFromBorder(lat: number, lng: number): number {
  const code = countryCodeAtOffline(lat, lng);
  if (!code) return 0;
  for (const step of [0.02, 0.05, 0.1, 0.25]) {
    const neighbours = [
      countryCodeAtOffline(lat + step, lng), countryCodeAtOffline(lat - step, lng),
      countryCodeAtOffline(lat, lng + step), countryCodeAtOffline(lat, lng - step),
    ];
    if (neighbours.some((n) => n !== code)) return step;
  }
  return 0.25;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "JevGeoGuessr/0.1 (https://github.com/EnesYilmazcode/JevGeoGuessr)";

let nextSlot = 0;
async function rateLimited<T>(call: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + 1100;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  return call();
}

/** The online answer. Used to audit a sample of the offline one, not on the hot path. */
export async function countryCodeAtOnline(lat: number, lng: number): Promise<string | null> {
  return rateLimited(async () => {
    const url = `${ENDPOINT}?format=jsonv2&zoom=3&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const json = await res.json() as { address?: { country_code?: string } };
    return json.address?.country_code?.toUpperCase() ?? null;
  });
}
