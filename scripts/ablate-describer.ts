// Does telling the describer what a player reads actually help?
//
//   npm run ablate:describer -- --set=data/dev.json --n=80
//
// Paired on the same photos and the same strategy, so the only thing that differs is the
// instructions the describer was given. Both observations are cached separately, keyed by their own
// instruction hash, so re-running this is nearly free.
//
// This exists because a prompt change is a hypothesis, and shipping one without measuring it is how
// a pipeline quietly gets worse while everyone assumes it got better.

import { readFileSync } from "node:fs";
import { fetchImage, type Photo } from "../src/kartaview.ts";
import { observe, DESCRIBERS, PlaceLeakError } from "../src/observe.ts";
import { locate } from "../src/locate.ts";
import { scoreGuess, type Point } from "../src/geo.ts";
import { countryCodeAtOffline } from "../src/truth.ts";
import { costOf, usd } from "../src/pricing.ts";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const setPath = new URL(`../${arg("set", "data/dev.json")}`, import.meta.url);
const limit = Number(arg("n", "80"));
const concurrency = Number(arg("concurrency", "4"));
const stages = Number(arg("stages", "3"));

type TestCase = { photo: Photo; truthCode: string; city: string };
const cases = (JSON.parse(readFileSync(setPath, "utf8")) as { cases: TestCase[] }).cases.slice(0, limit);
const variants = Object.keys(DESCRIBERS);

type Row = { truthCode: string; byVariant: Record<string, { points: number; km: number; hit: boolean; words: number }> };
const rows: Row[] = [];
let cursor = 0, describerCost = 0, jevTokens = 0, leaks = 0, errors = 0;

const wordCount = (o: object) =>
  Object.values(o).flatMap((v) => (Array.isArray(v) ? v : [String(v)])).join(" ").split(/\s+/).filter(Boolean).length;

async function worker() {
  while (cursor < cases.length) {
    const test = cases[cursor++]!;
    const truth: Point = { lat: test.photo.lat, lng: test.photo.lng };
    const byVariant: Row["byVariant"] = {};
    try {
      const image = await fetchImage(test.photo);
      for (const variant of variants) {
        const { observation, inputTokens, outputTokens, cached } = await observe(image, test.photo.id, { variant });
        if (!cached) describerCost += costOf("google/gemini-3.5-flash", { inputTokens, outputTokens });
        const located = await locate(observation, { stages, aggregate: "weighted" });
        jevTokens += located.inputTokens;
        byVariant[variant] = {
          ...scoreGuess(located.guess, truth),
          hit: countryCodeAtOffline(located.guess.lat, located.guess.lng) === test.truthCode,
          words: wordCount(observation),
        };
      }
      rows.push({ truthCode: test.truthCode, byVariant });
      console.log(`  ${test.truthCode}  ` + variants.map((v) => `${v} ${String(byVariant[v]!.points).padStart(4)}`).join("  "));
    } catch (error) {
      if (error instanceof PlaceLeakError) leaks += 1; else errors += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const n = rows.length;
if (!n) { console.log("no rounds completed"); process.exit(1); }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`\n${n} photos, ${stages} stages, weighted pin\n`);
console.log(`| describer | mean points | median km | within 500km | right country | words per record |`);
console.log(`|---|---:|---:|---:|---:|---:|`);
for (const v of variants) {
  const rs = rows.map((r) => r.byVariant[v]!);
  console.log(`| ${v} | ${Math.round(rs.reduce((a, r) => a + r.points, 0) / n)} | ${Math.round(median(rs.map((r) => r.km)))} | ${Math.round((rs.filter((r) => r.km <= 500).length / n) * 100)}% | ${Math.round((rs.filter((r) => r.hit).length / n) * 100)}% | ${Math.round(rs.reduce((a, r) => a + r.words, 0) / n)} |`);
}

// Paired differences are what matter here: the same photo, two instructions.
if (variants.length === 2) {
  const [a, b] = variants as [string, string];
  const diffs = rows.map((r) => r.byVariant[b]!.points - r.byVariant[a]!.points);
  const better = diffs.filter((d) => d > 0).length, worse = diffs.filter((d) => d < 0).length;
  const mean = diffs.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(diffs.reduce((x, d) => x + (d - mean) ** 2, 0) / Math.max(1, n - 1));
  const stderr = sd / Math.sqrt(n);
  console.log(`\npaired: ${b} beat ${a} on ${better} photos, lost on ${worse}, tied on ${n - better - worse}`);
  console.log(`mean difference ${mean >= 0 ? "+" : ""}${mean.toFixed(0)} points, standard error ${stderr.toFixed(0)}`);
  console.log(Math.abs(mean) > 2 * stderr
    ? `that is ${(Math.abs(mean) / stderr).toFixed(1)} standard errors, so the difference is real`
    : `that is inside two standard errors, so this run cannot tell them apart`);
}

console.log(`\ndescriber ${usd(describerCost)} (cached photos cost nothing), Jev ${usd(costOf("typesafe-ai/jev", { inputTokens: jevTokens, outputTokens: 0 }))}`);
console.log(`${leaks} place leaks, ${errors} errors`);
