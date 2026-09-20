// Builds the data behind the shareable card from a real run, picking the round that shows the
// result honestly rather than the luckiest one.
//
//   npm run card                          # best round from data/compare.json
//   npm run card -- --pick=median         # the median round, which is the fairer thing to post
//   npm run card -- --from=data/results.json
//
// No API calls. It reads what a run already wrote, so the card can never show a number that was
// not measured.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { countryByCode } from "../src/countries.ts";
import { countryCodeAtOffline } from "../src/truth.ts";
import type { Point } from "../src/geo.ts";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const from = arg("from", "data/compare.json");
const pick = arg("pick", "median");
const strategy = arg("strategy", "cells 3 stages argmax");
const source = new URL(`../${from}`, import.meta.url);
if (!existsSync(source)) throw new Error(`${from} not found. Run a comparison first.`);

type Round = { photo: string; truthCode: string; truth: Point; km: number; points: number; pin: Point; guessLabel: string };

const data = JSON.parse(readFileSync(source, "utf8")) as {
  rounds?: Record<string, unknown>[];
};
if (!data.rounds?.length) throw new Error(`${from} has no rounds.`);

// Older runs recorded which country was guessed but not where the photo actually was, so the true
// position is looked back up from the test set the run was fed, matched on the photo's own URL.
const truthByPhoto = new Map<string, Point>();
const truthSet = arg("truthFrom", "");
if (truthSet) {
  const set = JSON.parse(readFileSync(new URL(`../${truthSet}`, import.meta.url), "utf8")) as {
    cases: { photo: { url: string; lat: number; lng: number } }[];
  };
  for (const c of set.cases) truthByPhoto.set(c.photo.url, { lat: c.photo.lat, lng: c.photo.lng });
}

// Two shapes are accepted: a comparison, which carries a pin per strategy, and the older
// country-menu run, whose pin is the guessed country's centroid.
const normalise = (raw: Record<string, unknown>): Round | null => {
  const photo = String(raw["photo"] ?? "");
  const truthCode = String(raw["truthCode"] ?? "");

  const results = raw["results"] as Record<string, { points: number; km: number; pin?: Point }> | undefined;
  if (results?.[strategy]) {
    const r = results[strategy]!;
    if (!r.pin) return null;
    const truth = (raw["truth"] as Point | undefined) ?? truthByPhoto.get(photo);
    if (!truth) return null;
    // Label the pin by where the pin actually is. Labelling it with the truth would print a
    // claim the run never made.
    const landed = countryCodeAtOffline(r.pin.lat, r.pin.lng);
    return {
      photo, truthCode, truth, km: r.km, points: r.points, pin: r.pin,
      guessLabel: landed ? countryByCode(landed)?.name ?? landed : "open water",
    };
  }

  const guessCode = raw["guess"];
  if (typeof guessCode === "string") {
    const country = countryByCode(guessCode);
    const truth = (raw["truth"] as Point | undefined) ?? truthByPhoto.get(photo);
    if (!country || !truth) return null;
    return {
      photo, truthCode, truth,
      km: Number(raw["km"] ?? 0), points: Number(raw["points"] ?? 0),
      pin: { lat: country.lat, lng: country.lng },
      guessLabel: country.name,
    };
  }
  return null;
};

const usable = data.rounds.map(normalise).filter((r): r is Round => r !== null);
if (!usable.length) {
  throw new Error(`no usable rounds in ${from} for strategy "${strategy}". Re-run the comparison so pins are saved.`);
}

const sorted = [...usable].sort((a, b) => a.km - b.km);
const chosen = pick === "best" ? sorted[0]!
  : pick === "worst" ? sorted[sorted.length - 1]!
  : sorted[Math.floor(sorted.length / 2)]!;

const result = { km: chosen.km, points: chosen.points };
const guess = chosen.pin;

const card = {
  photo: chosen.photo,
  truth: chosen.truth,
  guess,
  km: result.km,
  points: result.points,
  guessLabel: chosen.guessLabel,
  truthLabel: countryByCode(chosen.truthCode)?.name ?? chosen.truthCode,
  subtitle: arg("subtitle", "off"),
  minSpanDeg: Number(arg("span", "14")),
};

writeFileSync(new URL("../web/card.json", import.meta.url), JSON.stringify(card, null, 1), "utf8");
console.log(`wrote web/card.json (${pick} of ${usable.length}: guessed ${card.guessLabel}, actually ${card.truthLabel}, ${card.km} km, ${card.points} points)`);
console.log(`open web/card.html to render it`);
