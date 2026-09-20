// The best score each menu design could possibly produce, if Jev chose perfectly every time.
//
//   npm run oracle -- --set=data/dev.json
//
// Pure geometry, no API calls, free. This matters because a menu has its own ceiling: guessing
// "the right country" still puts the pin at that country's centroid, and no amount of model quality
// beats that. Comparing a real run against this says which half of the system to work on. If the
// model is near the oracle, the menu is the limit. If it is far below, the menu is fine and the
// judgement is the problem.

import { readFileSync } from "node:fs";
import { partition, placeCells, places, type Cell, type Place } from "../src/cells.ts";
import { countryByCode } from "../src/countries.ts";
import { scoreGuess, distanceKm, type Point } from "../src/geo.ts";
import type { Photo } from "../src/kartaview.ts";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const setPath = new URL(`../${arg("set", "data/dev.json")}`, import.meta.url);
const MAX_OPTIONS = 200, SPLIT_DEPTH = 7;

type TestCase = { photo: Photo; truthCode: string; city: string };
const cases = (JSON.parse(readFileSync(setPath, "utf8")) as { cases: TestCase[] }).cases;
console.log(`${cases.length} photos from ${setPath.pathname.split("/").pop()}\n`);

const nearest = (cells: Cell[], truth: Point) =>
  cells.reduce((a, b) => (distanceKm(a.centre, truth) <= distanceKm(b.centre, truth) ? a : b));

/** Perfect play: at every stage take the cell whose centre is closest to where the photo really is. */
function oracleCells(truth: Point, stages: number): { points: number; km: number } {
  let pool: Place[] = places();
  let best: Cell | null = null;
  for (let s = 0; s < stages; s += 1) {
    const last = pool.length <= MAX_OPTIONS;
    const cells = last ? placeCells(pool) : partition(pool, SPLIT_DEPTH);
    if (cells.length < 2) break;
    best = nearest(cells, truth);
    if (last || best.places.length <= 1) break;
    pool = best.places;
  }
  return scoreGuess(best!.centre, truth);
}

/** The single nearest settlement in the places file: the finest this menu could ever be. */
function oracleFinest(truth: Point): { points: number; km: number } {
  let bestKm = Infinity, bestPoint: Point = truth;
  for (const p of places()) {
    const km = distanceKm({ lat: p.lat, lng: p.lng }, truth);
    if (km < bestKm) { bestKm = km; bestPoint = { lat: p.lat, lng: p.lng }; }
  }
  return scoreGuess(bestPoint, truth);
}

const rows = cases.map((test) => {
  const truth: Point = { lat: test.photo.lat, lng: test.photo.lng };
  const country = countryByCode(test.truthCode);
  return {
    country: country ? scoreGuess({ lat: country.lat, lng: country.lng }, truth) : { points: 0, km: 0 },
    cells1: oracleCells(truth, 1),
    cells2: oracleCells(truth, 2),
    cells3: oracleCells(truth, 3),
    finest: oracleFinest(truth),
  };
});

const n = rows.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`| menu, played perfectly | mean points | median km | within 100km | within 25km |`);
console.log(`|---|---:|---:|---:|---:|`);
for (const [label, key] of [
  ["Right country, pin on its centroid", "country"],
  ["Cells, 1 stage", "cells1"],
  ["Cells, 2 stages", "cells2"],
  ["Cells, 3 stages", "cells3"],
  ["Nearest settlement on the list", "finest"],
] as const) {
  const rs = rows.map((r) => r[key]);
  console.log(`| ${label} | ${Math.round(rs.reduce((a, r) => a + r.points, 0) / n)} | ${Math.round(median(rs.map((r) => r.km)))} | ${Math.round((rs.filter((r) => r.km <= 100).length / n) * 100)}% | ${Math.round((rs.filter((r) => r.km <= 25).length / n) * 100)}% |`);
}

console.log(`\nThese are ceilings, not results. A real run cannot beat the row it is playing.`);
