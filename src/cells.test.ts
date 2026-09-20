// The partition decides every menu, so a silent bug here quietly corrupts every measurement.
// Run with: node --experimental-strip-types --test src/cells.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { partition, placeCells, places, type Place } from "./cells.ts";
import { weightedCentre } from "./locate.ts";
import { distanceKm } from "./geo.ts";

const sample = (n: number): Place[] => places().slice(0, n);

test("a partition loses nothing and duplicates nothing", () => {
  const input = sample(4000);
  const cells = partition(input, 6);
  assert.equal(cells.length, 64);

  const seen = cells.flatMap((c) => c.places);
  assert.equal(seen.length, input.length, "place count changed");
  assert.equal(new Set(seen.map((p) => `${p.name}/${p.lat}/${p.lng}`)).size,
    new Set(input.map((p) => `${p.name}/${p.lat}/${p.lng}`)).size, "places duplicated or dropped");
});

test("cells are near balanced in place count", () => {
  const cells = partition(sample(4000), 6);
  const sizes = cells.map((c) => c.places.length);
  // Median splits, so any two cells differ by at most one.
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `sizes ranged ${Math.min(...sizes)}..${Math.max(...sizes)}`);
});

test("the partition is deterministic", () => {
  const input = sample(3000);
  const a = partition(input, 5).map((c) => c.id + ":" + c.places.length).join("|");
  const b = partition([...input], 5).map((c) => c.id + ":" + c.places.length).join("|");
  assert.equal(a, b);
});

test("cell ids are unique", () => {
  const cells = partition(sample(2000), 6);
  assert.equal(new Set(cells.map((c) => c.id)).size, cells.length);
});

test("a cell's centre lies inside its own bounding box", () => {
  for (const cell of partition(sample(3000), 5)) {
    const [minLng, minLat, maxLng, maxLat] = cell.bbox;
    assert.ok(cell.centre.lat >= minLat - 1e-6 && cell.centre.lat <= maxLat + 1e-6, `lat outside bbox in ${cell.id}`);
    assert.ok(cell.centre.lng >= minLng - 1e-6 && cell.centre.lng <= maxLng + 1e-6, `lng outside bbox in ${cell.id}`);
  }
});

test("labels name real places and say where they are", () => {
  for (const cell of partition(sample(2000), 4)) {
    assert.match(cell.label, /around -?\d+\.\d+[NS] -?\d+\.\d+[EW]\)$/, `bad label: ${cell.label}`);
    assert.ok(cell.label.length > 10);
  }
});

test("the finest menu is one option per place", () => {
  const input = sample(40);
  const cells = placeCells(input);
  assert.equal(cells.length, input.length);
  assert.equal(cells[0]!.places.length, 1);
  assert.equal(cells[0]!.centre.lat, input[0]!.lat);
});

test("spherical mean handles the antimeridian", () => {
  const mid = weightedCentre([
    { point: { lat: 0, lng: 179 }, weight: 1 },
    { point: { lat: 0, lng: -179 }, weight: 1 },
  ]);
  // Averaging the raw numbers would give longitude 0, on the far side of the planet.
  assert.ok(distanceKm(mid, { lat: 0, lng: 180 }) < 50, `got ${mid.lng}`);
});

test("spherical mean respects weights and ignores zeroes", () => {
  const paris = { lat: 48.85, lng: 2.35 };
  const near = weightedCentre([{ point: paris, weight: 0.99 }, { point: { lat: -33.87, lng: 151.2 }, weight: 0.01 }]);
  assert.ok(distanceKm(near, paris) < 400, `a 99% weight should stay near Paris, got ${distanceKm(near, paris)}km`);

  const only = weightedCentre([{ point: paris, weight: 1 }, { point: { lat: 10, lng: 10 }, weight: 0 }]);
  assert.ok(distanceKm(only, paris) < 1);
});

test("spherical mean does not explode on antipodal weights", () => {
  const out = weightedCentre([
    { point: { lat: 0, lng: 0 }, weight: 1 },
    { point: { lat: 0, lng: 180 }, weight: 1 },
  ]);
  assert.ok(Number.isFinite(out.lat) && Number.isFinite(out.lng), "returned a non-finite point");
});
