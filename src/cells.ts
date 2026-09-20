// A geographic menu, instead of a list of countries.
//
// Countries are the wrong shape for this problem. They are the wrong size (a right answer of
// "France" still leaves the pin 300km out) and the wrong shape (the land either side of a frontier
// looks identical, so the evidence in a photograph points at a region, not at a sovereign state).
//
// So the menu is regions of the world, cut so each holds a similar number of inhabited places, and
// it nests: pick a region, then a region inside that one, then a town. The partition is a k-d tree
// over real settlements, which means cells are small where people are and large where they are not,
// which is also where photographs are and are not.
//
// Nothing here is hand drawn. The splits fall out of the data and are deterministic, so the same
// places file always produces the same menu.

import { readFileSync, existsSync } from "node:fs";
import { countryByCode } from "./countries.ts";
import type { Point } from "./geo.ts";

export type Place = {
  name: string; lat: number; lng: number; country: string; admin1: string; population: number;
};

export type Cell = {
  id: string;
  places: Place[];
  /** Population weighted, so the pin lands where the roads and the photographs are. */
  centre: Point;
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  /** What Jev is told this option is. */
  label: string;
};

const PLACES_PATH = new URL("../data/places.json", import.meta.url);

let allPlaces: Place[] | null = null;
export function places(): Place[] {
  if (allPlaces) return allPlaces;
  if (!existsSync(PLACES_PATH)) throw new Error("data/places.json missing. Run: npm run places");
  allPlaces = JSON.parse(readFileSync(PLACES_PATH, "utf8")) as Place[];
  return allPlaces;
}

const KM_PER_DEG = 111;
const rad = (d: number) => (d * Math.PI) / 180;

function extents(group: Place[]): { lngKm: number; latKm: number; bbox: [number, number, number, number]; meanLat: number } {
  let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90, sumLat = 0;
  for (const p of group) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    sumLat += p.lat;
  }
  const meanLat = sumLat / group.length;
  return {
    // Longitude degrees are narrower away from the equator, so compare in kilometres or every
    // split near the poles cuts the wrong way.
    lngKm: (maxLng - minLng) * KM_PER_DEG * Math.cos(rad(meanLat)),
    latKm: (maxLat - minLat) * KM_PER_DEG,
    bbox: [minLng, minLat, maxLng, maxLat],
    meanLat,
  };
}

function centreOf(group: Place[]): Point {
  // Population weighted, with a floor so a cell of tiny towns still has a defined centre.
  let wSum = 0, lat = 0, lng = 0;
  for (const p of group) {
    const w = Math.max(p.population, 1000);
    wSum += w; lat += p.lat * w; lng += p.lng * w;
  }
  return { lat: lat / wSum, lng: lng / wSum };
}

function labelOf(group: Place[]): string {
  const byPop = [...group].sort((a, b) => b.population - a.population);
  const named = byPop.slice(0, 3).map((p) => p.name);

  const counts = new Map<string, number>();
  for (const p of group) counts.set(p.country, (counts.get(p.country) ?? 0) + 1);
  const countries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code]) => countryByCode(code)?.name ?? code);

  const centre = centreOf(group);
  const where = `${Math.abs(centre.lat).toFixed(1)}${centre.lat >= 0 ? "N" : "S"} ${Math.abs(centre.lng).toFixed(1)}${centre.lng >= 0 ? "E" : "W"}`;
  return `${named.join(", ")} and nearby (${countries.join(" / ")}; around ${where})`;
}

/**
 * Splits a set of places into `1 << depth` cells of roughly equal place count, cutting each group
 * along its longer side at the median. Deterministic: same input, same cells.
 */
export function partition(group: Place[], depth: number, prefix = "c"): Cell[] {
  if (depth <= 0 || group.length <= 1) {
    return [{
      id: prefix,
      places: group,
      centre: centreOf(group),
      bbox: extents(group).bbox,
      label: labelOf(group),
    }];
  }
  const { lngKm, latKm } = extents(group);
  const sorted = [...group].sort(lngKm >= latKm
    ? (a, b) => a.lng - b.lng || a.lat - b.lat || a.name.localeCompare(b.name)
    : (a, b) => a.lat - b.lat || a.lng - b.lng || a.name.localeCompare(b.name));
  const mid = Math.floor(sorted.length / 2);
  return [
    ...partition(sorted.slice(0, mid), depth - 1, `${prefix}0`),
    ...partition(sorted.slice(mid), depth - 1, `${prefix}1`),
  ];
}

/** The top level menu: `1 << depth` regions covering the inhabited world. */
export function worldCells(depth: number): Cell[] {
  return partition(places(), depth);
}

/** Turns a set of places into one option per place, for the last and finest stage. */
export function placeCells(group: Place[]): Cell[] {
  return group.map((p, i) => ({
    id: `p${i}`,
    places: [p],
    centre: { lat: p.lat, lng: p.lng },
    bbox: [p.lng, p.lat, p.lng, p.lat] as [number, number, number, number],
    label: `${p.name} (${countryByCode(p.country)?.name ?? p.country}${p.population >= 15000 ? `, population ${p.population.toLocaleString()}` : ""})`,
  }));
}
