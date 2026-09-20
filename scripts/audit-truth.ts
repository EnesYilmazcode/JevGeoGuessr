// Does the offline border lookup agree with Nominatim? Swapping ground truth for a faster method
// is only safe if it gives the same answers, so this checks a random sample of real city
// coordinates against the service it replaced.
//
//   npm run audit:truth -- --n=40

import { readFileSync } from "node:fs";
import { countryCodeAtOffline, countryCodeAtOnline, marginFromBorder } from "../src/truth.ts";
import { countryByCode } from "../src/countries.ts";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const want = Number(arg("n", "40"));
type City = { name: string; lat: string; lng: string; country: string };
const cities = (JSON.parse(readFileSync(new URL("../data/cities.json", import.meta.url), "utf8")) as City[])
  .filter((c) => countryByCode(c.country));

let state = 99;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let agree = 0, disagree = 0, offlineNull = 0;
const mismatches: string[] = [];

for (let i = 0; i < want; i += 1) {
  const city = cities[Math.floor(rand() * cities.length)]!;
  const lat = Number(city.lat), lng = Number(city.lng);

  const offline = countryCodeAtOffline(lat, lng);
  const online = await countryCodeAtOnline(lat, lng).catch(() => "ERR");
  if (online === "ERR") continue;

  if (offline === null) offlineNull += 1;
  if (offline === online) agree += 1;
  else {
    disagree += 1;
    mismatches.push(`  ${city.name} (dataset says ${city.country})  offline=${offline}  nominatim=${online}  margin=${marginFromBorder(lat, lng)}`);
  }
}

console.log(`\nagree ${agree}  disagree ${disagree}  offline returned null ${offlineNull}`);
if (mismatches.length) {
  console.log("\nmismatches:");
  for (const m of mismatches) console.log(m);
}
console.log(`\nagreement: ${((agree / (agree + disagree)) * 100).toFixed(1)}%`);
