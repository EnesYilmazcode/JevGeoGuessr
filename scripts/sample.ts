// Builds the test set. Run once; the result is committed so a run is reproducible and checkable.
//
//   npm run sample -- --n=60 --mode=balanced --seed=7
//
// balanced   one photo per country, countries drawn at random. Tests the whole 194 menu.
// population one photo per randomly drawn city. Mirrors where people actually live, and so leans
//            hard on the handful of countries with the most towns, the way a world map does.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { nearbyPhotos, fetchImage, type Photo } from "../src/kartaview.ts";
import { countryCodeAt } from "../src/truth.ts";
import { countryByCode } from "../src/countries.ts";

const CITIES_URL = "https://raw.githubusercontent.com/lutangar/cities.json/master/cities.json";
const CITIES_PATH = new URL("../data/cities.json", import.meta.url);
const OUT_PATH = new URL("../data/testset.json", import.meta.url);

type City = { name: string; lat: string; lng: string; country: string };
export type TestCase = { photo: Photo; truthCode: string; city: string };

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const want = Number(arg("n", "60"));
const mode = arg("mode", "balanced");
const seed = Number(arg("seed", "7"));

// Deterministic RNG so the same seed rebuilds the same test set.
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

const cities = JSON.parse(readFileSync(CITIES_PATH, "utf8")) as City[];
const byCountry = new Map<string, City[]>();
for (const city of cities) {
  if (!countryByCode(city.country)) continue; // keep to the 194 on the menu
  (byCountry.get(city.country) ?? byCountry.set(city.country, []).get(city.country)!).push(city);
}
const inMenu = cities.filter((c) => countryByCode(c.country));
console.log(`${inMenu.length} seed cities across ${byCountry.size} of 194 countries`);

const cases: TestCase[] = [];
const usedCountries = new Set<string>();
const triedCities = new Set<string>();
let attempts = 0;

while (cases.length < want && attempts < want * 40) {
  attempts += 1;

  let city: City;
  if (mode === "balanced") {
    const open = [...byCountry.keys()].filter((c) => !usedCountries.has(c));
    if (!open.length) break;
    city = pick(byCountry.get(pick(open))!);
  } else {
    city = pick(inMenu);
  }

  const cityKey = `${city.country}/${city.name}/${city.lat}`;
  if (triedCities.has(cityKey)) continue;
  triedCities.add(cityKey);

  let photos: Photo[] = [];
  try {
    photos = await nearbyPhotos(Number(city.lat), Number(city.lng), 1000);
  } catch {
    continue; // no coverage, or the endpoint stalled on a dense tile
  }
  if (!photos.length) continue;

  // Some photos are listed but never serve, answering 409 forever. A test set is supposed to
  // measure the model, so a photo that cannot be downloaded has no business being in it.
  let photo: Photo | undefined;
  for (const candidate of [pick(photos), pick(photos), pick(photos)]) {
    try {
      const bytes = await fetchImage(candidate, 2);
      if (bytes.byteLength > 20_000) { photo = candidate; break; }
    } catch { /* try another from the same place */ }
  }
  if (!photo) continue;

  // The photo can sit a little outside the seed city, so resolve truth from the photo itself.
  let truthCode: string | null = null;
  try {
    truthCode = await countryCodeAt(photo.lat, photo.lng);
  } catch {
    continue;
  }
  if (!truthCode || !countryByCode(truthCode)) continue;
  if (mode === "balanced" && usedCountries.has(truthCode)) continue;

  usedCountries.add(truthCode);
  cases.push({ photo, truthCode, city: city.name });
  console.log(`  ${String(cases.length).padStart(3)}/${want}  ${truthCode}  ${city.name}  (${photos.length} photos nearby)`);
}

writeFileSync(OUT_PATH, JSON.stringify({ mode, seed, builtAt: new Date().toISOString().slice(0, 10), cases }, null, 1), "utf8");
console.log(`\nwrote ${cases.length} cases across ${usedCountries.size} countries after ${attempts} attempts`);
