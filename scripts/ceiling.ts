// What is the most this pipeline could possibly score?
//
// The describer sees the photo and Jev does not, so a bad result has two possible causes: Jev is
// weak at the judgement, or the written record is throwing the evidence away before Jev sees it.
// Those need different fixes, and the run itself cannot tell them apart.
//
// So: hand the same photos straight to the vision model and let it name the country itself, with no
// ban, no record, and no Jev. That is the ceiling. The gap between it and the real pipeline is what
// the hand-off costs. If the ceiling is also low, the photographs simply do not say where they are
// and no amount of prompt work will fix it.
//
//   npm run ceiling -- --set=data/dev.json --n=60

import { readFileSync } from "node:fs";
import { generateObject } from "ai";
import { z } from "zod";
import { fetchImage, type Photo } from "../src/kartaview.ts";
import { COUNTRIES, countryByCode } from "../src/countries.ts";
import { scoreGuess } from "../src/geo.ts";
import { playRound } from "../src/guess.ts";
import { costOf, usd } from "../src/pricing.ts";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const setPath = new URL(`../${arg("set", "data/dev.json")}`, import.meta.url);
const limit = Number(arg("n", "60"));
const concurrency = Number(arg("concurrency", "4"));
const MODEL = "google/gemini-3.5-flash";

type TestCase = { photo: Photo; truthCode: string; city: string };
const testset = JSON.parse(readFileSync(setPath, "utf8")) as { cases: TestCase[] };
const cases = testset.cases.slice(0, limit);

const CODES = COUNTRIES.map((c) => c.code) as [string, ...string[]];
const Answer = z.object({
  country: z.enum(CODES).describe("ISO 3166-1 alpha-2 code of the country the photo was taken in"),
});

const PROMPT =
  "Where was this street level photograph taken? Answer with the ISO 3166-1 alpha-2 country code. " +
  "Use every cue: which side of the road traffic drives on, the script and language of any signs, " +
  "licence plate shape and colour, bollard and pole style, road markings, architecture, vegetation, " +
  "soil colour and sun angle. Give your single best guess even if you are unsure.";

type Row = { truth: string; direct: string | null; directPoints: number; pipeline: string | null; pipelinePoints: number };
const rows: Row[] = [];
let cursor = 0, directCost = 0;

async function worker() {
  while (cursor < cases.length) {
    const test = cases[cursor++]!;
    const truth = { lat: test.photo.lat, lng: test.photo.lng };
    const row: Row = { truth: test.truthCode, direct: null, directPoints: 0, pipeline: null, pipelinePoints: 0 };

    try {
      const image = await fetchImage(test.photo);
      const { object, usage } = await generateObject({
        model: MODEL,
        schema: Answer,
        messages: [{
          role: "user",
          content: [{ type: "text", text: PROMPT }, { type: "file", mediaType: "image/jpeg", data: { type: "data", data: image } }],
        }],
        abortSignal: AbortSignal.timeout(90_000),
      });
      directCost += costOf(MODEL, { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
      const guess = countryByCode(object.country);
      if (guess) {
        row.direct = guess.code;
        row.directPoints = scoreGuess({ lat: guess.lat, lng: guess.lng }, truth).points;
      }
    } catch { /* leave null */ }

    try {
      const round = await playRound(test.photo, test.truthCode);
      row.pipeline = round.guess.code;
      row.pipelinePoints = round.points;
    } catch { /* leave null */ }

    rows.push(row);
    const mark = (g: string | null) => (g === row.truth ? "HIT " : g ? "miss" : "err ");
    console.log(`  direct ${mark(row.direct)} ${String(row.direct).padEnd(3)}  pipeline ${mark(row.pipeline)} ${String(row.pipeline).padEnd(3)}  truth ${row.truth}`);
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const scored = rows.filter((r) => r.direct && r.pipeline);
const n = scored.length;
const directHits = scored.filter((r) => r.direct === r.truth).length;
const pipelineHits = scored.filter((r) => r.pipeline === r.truth).length;
const mean = (f: (r: Row) => number) => Math.round(scored.reduce((a, r) => a + f(r), 0) / n);

console.log(`\n${n} photos scored both ways\n`);
console.log(`| | correct country | mean points |`);
console.log(`|---|---:|---:|`);
console.log(`| Vision model naming the country directly (ceiling) | ${directHits} of ${n} (${Math.round((directHits / n) * 100)}%) | ${mean((r) => r.directPoints)} |`);
console.log(`| Place-blind record, then Jev picks from 194 | ${pipelineHits} of ${n} (${Math.round((pipelineHits / n) * 100)}%) | ${mean((r) => r.pipelinePoints)} |`);

const agree = scored.filter((r) => r.direct === r.pipeline).length;
const bothRight = scored.filter((r) => r.direct === r.truth && r.pipeline === r.truth).length;
const onlyDirect = scored.filter((r) => r.direct === r.truth && r.pipeline !== r.truth).length;
const onlyPipeline = scored.filter((r) => r.direct !== r.truth && r.pipeline === r.truth).length;

console.log(`\nthey picked the same country on ${agree} of ${n}`);
console.log(`both right ${bothRight}   only the direct model ${onlyDirect}   only the Jev pipeline ${onlyPipeline}`);
console.log(`\nthe hand-off costs ${directHits - pipelineHits} photos (${Math.round(((directHits - pipelineHits) / n) * 100)} points of accuracy)`);
console.log(`direct calls cost ${usd(directCost)}`);
