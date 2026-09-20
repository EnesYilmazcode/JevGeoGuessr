// Builds a test set. Run once per split; the result is committed so a run is reproducible.
//
//   npm run sample -- --n=150 --mode=balanced --seed=7  --out=data/dev.json
//   npm run sample -- --n=300 --mode=balanced --seed=91 --out=data/test.json
//
// balanced   spreads photos across countries, so the whole 194 menu is actually exercised.
// population draws cities at random, so the set leans where people live, the way a world map does.
//
// Two splits exist on purpose. Prompts get tuned against dev. test is run once, at the end, and
// any number quoted from a set that was tuned against is not a measurement of anything.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { nearbyPhotos, fetchImage, type Photo } from "../src/kartaview.ts";
import { countryCodeAtOffline, marginFromBorder } from "../src/truth.ts";
import { countryByCode } from "../src/countries.ts";

const CITIES_URL = "https://raw.githubusercontent.com/lutangar/cities.json/master/cities.json";
const CITIES_PATH = new URL("../data/cities.json", import.meta.url);

type City = { name: string; lat: string; lng: string; country: string };
export type TestCase = { photo: Photo; truthCode: string; city: string };

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const want = Number(arg("n", "150"));
const mode = arg("mode", "balanced");
const seed = Number(arg("seed", "7"));
const outPath = new URL(`../${arg("out", "data/dev.json")}`, import.meta.url);
const concurrency = Number(arg("concurrency", "6"));

// A photo this close to a frontier is not a fair test of telling two countries apart.
const MIN_BORDER_MARGIN = 0.02; // degrees, roughly two kilometres

let state = seed >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

if (!existsSync(CITIES_PATH)) {
  console.log("downloading city seed list...");
  const res = await fetch(CITIES_URL, { signal: AbortSignal.timeout(300_000) });
  writeFileSync(CITIES_PATH, new Uint8Array(await res.arrayBuffer()));
}

// Only draw from countries KartaView is known to have photos in. Without this, balanced sampling
// spends most of its time asking for a photo in a country that has none, and each of those asks
// costs a thirty second network timeout. See scripts/build-coverage.mjs.
const COVERAGE_PATH = new URL("../data/coverage.json", import.meta.url);
const covered: Set<string> | null = existsSync(COVERAGE_PATH)
  ? new Set((JSON.parse(readFileSync(COVERAGE_PATH, "utf8")) as { covered: string[] }).covered)
  : null;
if (!covered) console.log("data/coverage.json missing, falling back to probing every country (slow)");

const eligible = (code: string) => !!countryByCode(code) && (!covered || covered.has(code));

const cities = JSON.parse(readFileSync(CITIES_PATH, "utf8")) as City[];
const byCountry = new Map<string, City[]>();
for (const city of cities) {
  if (!eligible(city.country)) continue;
  const list = byCountry.get(city.country);
  if (list) list.push(city); else byCountry.set(city.country, [city]);
}
const inMenu = cities.filter((c) => eligible(c.country));
console.log(`${inMenu.length} seed cities across ${byCountry.size} countries with known coverage`);
console.log(`Jev still picks from all 194; the truth can only ever be one of these ${byCountry.size}`);
console.log(`target ${want} photos, mode=${mode} seed=${seed} -> ${outPath.pathname.split("/").pop()}\n`);

const cases: TestCase[] = [];
const perCountry = new Map<string, number>();
const tried = new Set<string>();
let attempts = 0, noCoverage = 0, badImage = 0, nearBorder = 0, noTruth = 0;

// In balanced mode, allow a country a second photo only once every country has had a first.
const quotaFor = () => Math.max(1, Math.ceil(want / byCountry.size));

function nextCity(): City | null {
  if (mode !== "balanced") return pick(inMenu);
  const quota = quotaFor();
  const open = [...byCountry.keys()].filter((c) => (perCountry.get(c) ?? 0) < quota);
  if (!open.length) return null;
  return pick(byCountry.get(pick(open))!);
}

const stop = () => cases.length >= want || attempts >= want * 30;

async function worker(): Promise<void> {
  while (!stop()) {
    attempts += 1;
    const city = nextCity();
    if (!city) return;

    const key = `${city.country}/${city.name}/${city.lat}`;
    if (tried.has(key)) continue;
    tried.add(key);

    let photos: Photo[];
    try {
      photos = await nearbyPhotos(Number(city.lat), Number(city.lng), 1000);
    } catch { noCoverage += 1; continue; }
    if (!photos.length) { noCoverage += 1; continue; }

    // Truth first: it is free now, so spend nothing downloading a photo we would discard.
    const candidate = pick(photos);
    const truthCode = countryCodeAtOffline(candidate.lat, candidate.lng);
    if (!truthCode || !countryByCode(truthCode)) { noTruth += 1; continue; }
    if (marginFromBorder(candidate.lat, candidate.lng) < MIN_BORDER_MARGIN) { nearBorder += 1; continue; }

    const quota = quotaFor();
    if (mode === "balanced" && (perCountry.get(truthCode) ?? 0) >= quota) continue;

    // Some photos are listed but never serve. A test set measures the model, so a photo that
    // cannot be downloaded has no business being in it.
    try {
      const bytes = await fetchImage(candidate, 2);
      if (bytes.byteLength < 20_000) { badImage += 1; continue; }
    } catch { badImage += 1; continue; }

    if (stop()) return;
    perCountry.set(truthCode, (perCountry.get(truthCode) ?? 0) + 1);
    cases.push({ photo: candidate, truthCode, city: city.name });
    if (cases.length % 10 === 0) {
      console.log(`  ${String(cases.length).padStart(4)}/${want}  ${perCountry.size} countries  ${attempts} attempts`);
    }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, worker));

cases.sort((a, b) => a.truthCode.localeCompare(b.truthCode));
writeFileSync(outPath, JSON.stringify({
  mode, seed, minBorderMargin: MIN_BORDER_MARGIN,
  builtAt: new Date().toISOString().slice(0, 10), cases,
}, null, 1), "utf8");

console.log(`\n${cases.length} photos across ${perCountry.size} countries in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`skipped: ${noCoverage} no coverage, ${nearBorder} too near a border, ${badImage} unusable image, ${noTruth} no truth`);
