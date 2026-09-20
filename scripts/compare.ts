// Runs several ways of turning one observation into a pin, on the same photos, and prints them
// side by side.
//
//   npm run compare -- --set=data/dev.json --n=80
//
// Every variant reads the same cached observation for a given photo, so the vision model runs once
// per photo no matter how many variants there are and the comparison is paired: the differences
// below are the strategies, not different luck with the describer.

import { readFileSync, writeFileSync } from "node:fs";
import { fetchImage, type Photo } from "../src/kartaview.ts";
import { observe, PlaceLeakError } from "../src/observe.ts";
import { rankCountries } from "../src/jev.ts";
import { locate, weightedCentre } from "../src/locate.ts";
import { scoreGuess, distanceKm, type Point } from "../src/geo.ts";
import { countryCodeAtOffline } from "../src/truth.ts";
import { baselines } from "../src/baselines.ts";
import { usd, costOf } from "../src/pricing.ts";
import { isBudgetError, BudgetExhausted, reportCredits } from "../src/budget.ts";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const setPath = new URL(`../${arg("set", "data/dev.json")}`, import.meta.url);
const limit = Number(arg("n", "80"));
const concurrency = Number(arg("concurrency", "4"));

type TestCase = { photo: Photo; truthCode: string; city: string };
const testset = JSON.parse(readFileSync(setPath, "utf8")) as { mode: string; seed: number; cases: TestCase[] };
const cases = testset.cases.slice(0, limit);

type VariantResult = { points: number; km: number; countryHit: boolean; pin: Point };
type Row = { truth: Point; truthCode: string; photo: string; results: Record<string, VariantResult> };
type Pin = { lat: number; lng: number };

// Each entry is one way of turning a distribution into a pin. They all read the same observation.
const STRATEGIES = [
  { name: "cells 1 stage", stages: 1, aggregate: "weighted", beam: 1, minConfidence: 0 },
  { name: "cells 2 stages", stages: 2, aggregate: "weighted", beam: 1, minConfidence: 0 },
  { name: "cells 3 stages", stages: 3, aggregate: "weighted", beam: 1, minConfidence: 0 },
  { name: "cells 3 stages argmax", stages: 3, aggregate: "argmax", beam: 1, minConfidence: 0 },
  { name: "cells 3 stages beam 3", stages: 3, aggregate: "weighted", beam: 3, minConfidence: 0 },
  { name: "cells 3 stages beam 3, gated", stages: 3, aggregate: "weighted", beam: 3, minConfidence: 0.25 },
] as const;

const VARIANTS = ["country", "country weighted", ...STRATEGIES.map((s) => s.name)] as const;

const rows: Row[] = [];
let cursor = 0, jevTokens = 0, jevCalls = 0, describerCost = 0, leaks = 0, errors = 0;
const errorKinds = new Map<string, number>();
let budgetHit: string | null = null;
const started = Date.now();

async function worker() {
  while (cursor < cases.length) {
    const test = cases[cursor++]!;
    const truth: Point = { lat: test.photo.lat, lng: test.photo.lng };

    try {
      const image = await fetchImage(test.photo);
      const { observation, inputTokens, outputTokens, cached } = await observe(image, test.photo.id);
      if (!cached) describerCost += costOf("google/gemini-3.5-flash", { inputTokens, outputTokens });

      const results: Record<string, VariantResult> = {};

      // The country menu, scored two ways off the same single call.
      const countries = await rankCountries(observation);
      jevTokens += countries.inputTokens; jevCalls += 1;
      const top = countries.top;
      const countryPin = { lat: top.lat, lng: top.lng };
      results["country"] = {
        ...scoreGuess(countryPin, truth),
        countryHit: top.code === test.truthCode,
        pin: countryPin,
      };
      const blended = weightedCentre(countries.ranking.map((r) => ({
        point: { lat: r.country.lat, lng: r.country.lng }, weight: r.probability,
      })));
      results["country weighted"] = { ...scoreGuess(blended, truth), countryHit: top.code === test.truthCode, pin: blended };

      for (const strategy of STRATEGIES) {
        const located = await locate(observation, strategy);
        jevTokens += located.inputTokens; jevCalls += located.calls;
        results[strategy.name] = {
          ...scoreGuess(located.guess, truth),
          countryHit: countryCodeAtOffline(located.guess.lat, located.guess.lng) === test.truthCode,
          pin: located.guess,
        };
      }

      rows.push({ truth, truthCode: test.truthCode, photo: test.photo.url, results });
      const best = (VARIANTS as readonly string[]).reduce((a, b) => (results[a]!.points >= results[b]!.points ? a : b));
      console.log(`  ${test.truthCode}  country ${String(results["country"]!.points).padStart(4)}  cells3 ${String(results["cells 3 stages"]!.points).padStart(4)}  best: ${best}`);
    } catch (error) {
      if (error instanceof PlaceLeakError) { leaks += 1; continue; }
      // Spend failures are not per-photo errors. Carrying on just burns the rest of the test set
      // and produces a table that looks fine and is mostly missing.
      if (isBudgetError(error)) { budgetHit = String((error as Error).message); cursor = cases.length; return; }
      errors += 1;
      // Swallowing these hid that most of a run was failing. Keep the reasons.
      const why = String((error as Error).message ?? error).slice(0, 90);
      errorKinds.set(why, (errorKinds.get(why) ?? 0) + 1);
    }
  }
}

await reportCredits();
console.log("");
await Promise.all(Array.from({ length: concurrency }, worker));
if (budgetHit) throw new BudgetExhausted(budgetHit);

const reportErrors = () => {
  if (!errorKinds.size) return;
  console.log(`\nwhy rounds failed (${errors} of ${cases.length}):`);
  for (const [why, count] of [...errorKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(count).padStart(4)}x  ${why}`);
  }
};

const n = rows.length;
if (!n) { reportErrors(); console.log("no rounds completed"); process.exit(1); }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`\n${n} photos, set=${setPath.pathname.split("/").pop()} mode=${testset.mode}\n`);
console.log(`| strategy | mean points | median km | within 100km | within 500km | right country |`);
console.log(`|---|---:|---:|---:|---:|---:|`);

const summary: Record<string, unknown> = {};
for (const v of VARIANTS) {
  const rs = rows.map((r) => r.results[v]!);
  const pts = Math.round(rs.reduce((a, r) => a + r.points, 0) / n);
  const km = Math.round(median(rs.map((r) => r.km)));
  const near100 = rs.filter((r) => r.km <= 100).length;
  const near500 = rs.filter((r) => r.km <= 500).length;
  const hits = rs.filter((r) => r.countryHit).length;
  summary[v] = { meanPoints: pts, medianKm: km, within100: near100, within500: near500, countryHits: hits };
  console.log(`| ${v} | ${pts} | ${km} | ${Math.round((near100 / n) * 100)}% | ${Math.round((near500 / n) * 100)}% | ${Math.round((hits / n) * 100)}% |`);
}

for (const b of baselines(rows.map((r) => r.truth), rows.map((r) => r.truthCode))) {
  console.log(`| _${b.name}_ | ${Math.round(b.meanPoints)} | | | | ${(b.accuracy * 100).toFixed(0)}% |`);
}

const jevCost = costOf("typesafe-ai/jev", { inputTokens: jevTokens, outputTokens: 0 });
console.log(`\nJev: ${jevCalls} calls, ${jevTokens.toLocaleString()} tokens, ${usd(jevCost)}`);
console.log(`describer: ${usd(describerCost)} (cached photos cost nothing)`);
console.log(`${((Date.now() - started) / 1000).toFixed(0)}s wall clock, ${leaks} place leaks, ${errors} errors`);
reportErrors();

writeFileSync(new URL("../data/compare.json", import.meta.url), JSON.stringify({
  ranAt: new Date().toISOString(), set: setPath.pathname.split("/").pop(), n, summary,
 // Per round, so a render or a re-analysis never needs the API again.
 rounds: rows.map((r) => ({
  photo: r.photo, truthCode: r.truthCode, truth: r.truth,
  results: Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, { points: v.points, km: Math.round(v.km), countryHit: v.countryHit, pin: v.pin }])),
 })),
  baselines: baselines(rows.map((r) => r.truth), rows.map((r) => r.truthCode)),
}, null, 1), "utf8");
console.log("wrote data/compare.json");
