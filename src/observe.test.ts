// The place-blindness check is the one thing holding the claim up, so it gets tests.
// Run with: node --experimental-strip-types --test src/observe.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPlaceBlind, signsNameAPlace, PlaceLeakError, type Observation } from "./observe.ts";

const base: Observation = {
  sign_text_verbatim: [],
  driving_side: "right",
  road_surface_and_markings: "asphalt with a solid white edge line",
  license_plates: "not legible",
  poles_bollards_barriers: "concrete poles with a reflective band",
  architecture: "two storey rendered buildings with flat roofs",
  vegetation: "broad leaved trees and mown grass",
  terrain_and_soil: "flat, pale sandy soil",
  sky_and_light: "hazy, high sun",
  vehicles: "a white hatchback",
  other_details: "overhead wires",
};

const withField = (field: keyof Observation, value: string): Observation =>
  ({ ...base, [field]: value });

const leaks = (o: Observation) => {
  try { assertPlaceBlind(o); return null; } catch (e) { return (e as PlaceLeakError).term; }
};

test("a clean observation passes", () => {
  assert.equal(leaks(base), null);
});

test("country names, capitals and demonyms are caught", () => {
  for (const [field, text] of [
    ["architecture", "typical of Brazil"],
    ["vegetation", "plants common in Kenya"],
    ["other_details", "this looks like Paris"],
    ["architecture", "a French balcony"],
    ["vehicles", "a Japanese kei truck"],
    ["terrain_and_soil", "soil of the sort found in South Africa"],
  ] as const) {
    assert.ok(leaks(withField(field, text)), `missed a place in: ${text}`);
  }
});

test("continents, languages and scripts are caught", () => {
  assert.ok(leaks(withField("architecture", "a European apartment block")));
  assert.ok(leaks(withField("other_details", "the sign is in Cyrillic")));
  assert.ok(leaks(withField("sign_text_verbatim" === "sign_text_verbatim" ? "other_details" : "other_details", "written in Arabic")));
});

test("ordinary geography is not mistaken for a country name", () => {
  // These all used to fail, because multi-word country names were being split into words.
  for (const text of [
    "small islands are visible offshore",
    "a rocky island in the bay",
    "the coast is visible in the distance",
    "a cape of land juts into the water",
    "the road runs north to south along a central reservation",
    "a new building beside an older one",
    "the united frontage of a terraced row",
    "a sierra of jagged peaks on the horizon",
  ]) {
    assert.equal(leaks(withField("terrain_and_soil", text)), null, `false positive on: ${text}`);
  }
});

test("claims of recognition are caught, ordinary description is not", () => {
  assert.ok(leaks(withField("architecture", "a very tall, iconic metal lattice tower")));
  assert.ok(leaks(withField("architecture", "a famous bridge")));
  assert.equal(leaks(withField("architecture", "a very tall metal lattice tower tapering to a spire")), null);
  // "characteristic of late summer" is a real observation about the light, not a pointer.
  assert.equal(leaks(withField("sky_and_light", "foliage characteristic of late summer")), null);
});

test("copied sign text is exempt, but reported separately", () => {
  const signed = { ...base, sign_text_verbatim: ["PARIS 12 km", "SORTIE"] };
  assert.equal(leaks(signed), null, "copied signs must not be rejected");
  assert.equal(signsNameAPlace(signed), true);
  assert.equal(signsNameAPlace({ ...base, sign_text_verbatim: ["STOP", "2,6m"] }), false);
});
