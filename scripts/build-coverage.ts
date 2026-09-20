// Which countries does KartaView actually have street level photos in?
//
// The sampler used to rediscover this every run, and it is what made building a test set take
// forty minutes. Asking for a photo in a country with no coverage costs a thirty second network
// timeout, and balanced sampling asks for every country, so most of the wall clock was spent
// waiting on places that were never going to answer.
//
// Probed once, cached, committed. It is also a fact worth knowing: a 194 country menu is honest,
// but the truth on any test set can only ever be one of the countries listed here.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { COUNTRIES } from "../src/countries.ts";

const CITIES = new URL("../data/cities.json", import.meta.url);
const OUT = new URL("../data/coverage.json", import.meta.url);

const PROBES_PER_COUNTRY = Number(process.argv.find((a) => a.startsWith("--probes="))?.split("=")[1] ?? 6);
const CONCURRENCY = 8;

if (!existsSync(CITIES)) throw new Error("data/cities.json missing. Run the sampler once, or fetch it.");

const inMenu = new Set(COUNTRIES.map((c) => c.code));

type City = { name: string; lat: string; lng: string; country: string };
const cities = JSON.parse(readFileSync(CITIES, "utf8")) as City[];
const byCountry = new Map<string, City[]>();
for (const city of cities) {
  if (!inMenu.has(city.country)) continue;
  const list = byCountry.get(city.country);
  if (list) list.push(city); else byCountry.set(city.country, [city]);
}

// Biggest cities first is not available, so spread the probes across the list instead of taking
// the first few, which tend to cluster alphabetically in one region.
const spread = (list: City[], n: number): City[] => {
  const out: City[] = [];
  for (let i = 0; i < n && i < list.length; i += 1) out.push(list[Math.floor((i * list.length) / n)]!);
  return out;
};

async function probe(lat: number, lng: number): Promise<number> {
  try {
    const res = await fetch("https://api.openstreetcam.org/1.0/list/nearby-photos/", {
      method: "POST",
      body: new URLSearchParams({ lat: String(lat), lng: String(lng), radius: "1000" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return 0;
    const json = await res.json() as { currentPageItems?: { projection: string }[] };
    return (json.currentPageItems ?? []).filter((p) => p.projection === "PLANE").length;
  } catch {
    return 0; // a stall on a dense tile also means "do not build a test set from here"
  }
}

const codes = [...byCountry.keys()].sort();
const result: Record<string, { probes: number; hits: number; photos: number }> = {};
let cursor = 0, done = 0;

async function worker() {
  while (cursor < codes.length) {
    const code = codes[cursor++]!;
    const probes = spread(byCountry.get(code)!, PROBES_PER_COUNTRY);
    let photos = 0, hits = 0;
    for (const city of probes) {
      const found = await probe(Number(city.lat), Number(city.lng));
      photos += found;
      if (found > 0) hits += 1;
    }
    result[code] = { probes: probes.length, hits, photos };
    done += 1;
    if (hits > 0) console.log(`  ${code}  ${hits}/${probes.length} probes, ${photos} photos   [${done}/${codes.length}]`);
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const covered = Object.entries(result).filter(([, v]) => v.hits > 0).map(([k]) => k).sort();
writeFileSync(OUT, JSON.stringify({
  builtAt: new Date().toISOString().slice(0, 10),
  probesPerCountry: PROBES_PER_COUNTRY,
  covered,
  detail: result,
}, null, 1), "utf8");

console.log(`\n${covered.length} of ${codes.length} countries have coverage, probed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(covered.join(" "));
