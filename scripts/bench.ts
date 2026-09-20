// Runs the committed test set and prints the table that goes in the README.
//
//   npm run bench -- --set=data/testset.json --concurrency=4
//
// Every number it prints is measured here. Nothing is carried over from a previous run.

import { readFileSync, writeFileSync } from "node:fs";
import { playRound, type Round } from "../src/guess.ts";
import { countryByCode } from "../src/countries.ts";
import { PlaceLeakError } from "../src/observe.ts";
import { usd } from "../src/pricing.ts";
import type { Photo } from "../src/kartaview.ts";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const setPath = new URL(`../${arg("set", "data/testset.json")}`, import.meta.url);
const concurrency = Number(arg("concurrency", "4"));

type TestCase = { photo: Photo; truthCode: string; city: string };
const testset = JSON.parse(readFileSync(setPath, "utf8")) as { mode: string; seed: number; cases: TestCase[] };

console.log(`${testset.cases.length} photos, mode=${testset.mode} seed=${testset.seed}, concurrency ${concurrency}\n`);

const rounds: Round[] = [];
const leaks: { truthCode: string; message: string }[] = [];
const failures: { truthCode: string; message: string }[] = [];

let cursor = 0;
const started = Date.now();

async function worker() {
  while (cursor < testset.cases.length) {
    const index = cursor++;
    const test = testset.cases[index]!;
    const truthName = countryByCode(test.truthCode)?.name ?? test.truthCode;
    try {
      const round = await playRound(test.photo, test.truthCode);
      rounds.push(round);
      const mark = round.correct ? "HIT " : "MISS";
      const shown = round.correct ? "" : ` -> ${round.guess.name}`;
      console.log(`  ${mark} ${truthName}${shown}  rank ${round.rankOfTruth ?? "?"}  ${round.points}pts  ${Math.round(round.km)}km`);
    } catch (error) {
      if (error instanceof PlaceLeakError) {
        leaks.push({ truthCode: test.truthCode, message: error.message });
        console.log(`  LEAK ${truthName}  ${error.message}`);
      } else {
        failures.push({ truthCode: test.truthCode, message: String((error as Error).message).slice(0, 120) });
        console.log(`  ERR  ${truthName}  ${String((error as Error).message).slice(0, 100)}`);
      }
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const wallSeconds = (Date.now() - started) / 1000;
const n = rounds.length;
if (!n) { console.log("\nNo rounds completed."); process.exit(1); }

const sum = (f: (r: Round) => number) => rounds.reduce((a, r) => a + f(r), 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const hits = rounds.filter((r) => r.correct).length;
const top3 = rounds.filter((r) => r.rankOfTruth !== null && r.rankOfTruth <= 3).length;
const top5 = rounds.filter((r) => r.rankOfTruth !== null && r.rankOfTruth <= 5).length;
const jevCost = sum((r) => r.jevCost);
const describerCost = sum((r) => r.describerCost);

const row = (label: string, subset: Round[]) => {
  if (!subset.length) return `| ${label} | none | | | |`;
  const h = subset.filter((r) => r.correct).length;
  const pts = Math.round(subset.reduce((a, r) => a + r.points, 0) / subset.length);
  const km = Math.round(median(subset.map((r) => r.km)));
  return `| ${label} | ${h} of ${subset.length} | ${Math.round((h / subset.length) * 100)}% | ${pts} | ${km} |`;
};

console.log(`\n| | correct country | | mean points | median km |`);
console.log(`|---|---:|---:|---:|---:|`);
console.log(row("All photos", rounds));
console.log(row("Photos with no place name on any sign", rounds.filter((r) => !r.signsNamedAPlace)));
console.log(row("Photos where a sign named a place", rounds.filter((r) => r.signsNamedAPlace)));

console.log(`\ntruth in top 3: ${top3} of ${n} (${Math.round((top3 / n) * 100)}%)   top 5: ${top5} of ${n} (${Math.round((top5 / n) * 100)}%)`);
console.log(`chance at this menu size: ${(100 / 194).toFixed(1)}%`);

console.log(`\nJev        ${Math.round(sum((r) => r.jevTokens) / n)} tokens and ${Math.round(sum((r) => r.jevMs) / n)} ms per guess, ${usd(jevCost)} for all ${n}`);
console.log(`describer  ${usd(describerCost)} for all ${n}`);
console.log(`total      ${usd(jevCost + describerCost)}, which is ${usd((jevCost + describerCost) / n)} a guess. Jev is ${Math.round((jevCost / (jevCost + describerCost)) * 100)}% of it.`);
console.log(`wall clock ${wallSeconds.toFixed(0)}s at concurrency ${concurrency}`);
if (leaks.length) console.log(`\n${leaks.length} observations rejected for naming a place or pointing.`);
if (failures.length) console.log(`${failures.length} rounds failed outright.`);

writeFileSync(new URL("../data/results.json", import.meta.url), JSON.stringify({
  ranAt: new Date().toISOString(),
  set: { mode: testset.mode, seed: testset.seed, size: testset.cases.length },
  summary: {
    completed: n, hits, top3, top5,
    meanPoints: Math.round(sum((r) => r.points) / n),
    medianKm: Math.round(median(rounds.map((r) => r.km))),
    jevCost, describerCost, wallSeconds,
  },
  leaks, failures,
  rounds: rounds.map((r) => ({
    truthCode: r.truthCode, guess: r.guess.code, correct: r.correct, rankOfTruth: r.rankOfTruth,
    points: r.points, km: Math.round(r.km), signsNamedAPlace: r.signsNamedAPlace,
    jevTokens: r.jevTokens, jevMs: r.jevMs,
    top5: r.ranking.slice(0, 5).map((x) => [x.country.code, x.probability]),
    photo: r.photo.url, observation: r.observation,
  })),
}, null, 1), "utf8");
console.log(`\nwrote data/results.json`);
