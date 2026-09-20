// Plays one round the way a person plays it: look, guess, drive on, look again, revise.
//
//   npm run drive -- 48.8584 2.2945
//   npm run drive -- 35.6762 139.6503 --frames=8 --out=web/drive.json
//
// After every new frame Jev is handed every look so far, oldest first, and re-scores the whole
// menu. So the pin is allowed to move, and the interesting part of the recording is where it
// moves a long way because one late frame contradicted everything before it.
//
// Writes the whole round, every observation and every pin, so the video can be rendered from it
// without touching the API again.

import { writeFileSync } from "node:fs";
import { findDrive } from "../src/sequence.ts";
import { fetchImage } from "../src/kartaview.ts";
import { observe, PlaceLeakError, type Observation } from "../src/observe.ts";
import { locate } from "../src/locate.ts";
import { scoreGuess, distanceKm, type Point } from "../src/geo.ts";
import { countryCodeAtOffline } from "../src/truth.ts";
import { countryByCode } from "../src/countries.ts";
import { costOf, usd } from "../src/pricing.ts";
import { isBudgetError, BudgetExhausted, reportCredits } from "../src/budget.ts";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const [lat = NaN, lng = NaN] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(Number);
if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error("usage: npm run drive -- <lat> <lng> [--frames=10] [--stages=3] [--out=web/drive.json]");
  process.exit(1);
}

const maxFrames = Number(arg("frames", "10"));
const stages = Number(arg("stages", "3"));
const beam = Number(arg("beam", "3"));
const out = arg("out", "web/drive.json");

await reportCredits();

const drive = await findDrive(lat, lng, { maxFrames });
if (!drive) { console.error("No drive with enough frames there."); process.exit(1); }

const truthCode = countryCodeAtOffline(drive.origin.lat, drive.origin.lng);
console.log(`\ndrive ${drive.sequenceId}: ${drive.frames.length} frames over ${drive.spanKm.toFixed(2)} km`);
console.log(`actually ${truthCode ? countryByCode(truthCode)?.name ?? truthCode : "unknown"}\n`);

type Step = {
  photo: string;
  at: Point;
  heading: number | null;
  observation: Observation;
  guess: Point;
  km: number;
  points: number;
  /** How far the pin moved because of this frame. The revisions are the story. */
  movedKm: number;
  landedIn: string | null;
  topLabel: string;
  topProbability: number;
};

const evidence: Observation[] = [];
const steps: Step[] = [];
let describerCost = 0, jevTokens = 0;

try {
  for (const [i, frame] of drive.frames.entries()) {
    const image = await fetchImage(frame);
    let observation: Observation;
    try {
      const seen = await observe(image, frame.id);
      observation = seen.observation;
      if (!seen.cached) {
        describerCost += costOf("google/gemini-3.5-flash", { inputTokens: seen.inputTokens, outputTokens: seen.outputTokens });
      }
    } catch (error) {
      if (error instanceof PlaceLeakError) { console.log(`  frame ${i + 1}: rejected, ${error.message}`); continue; }
      throw error;
    }

    evidence.push(observation);
    const located = await locate(evidence, { stages, beam, aggregate: "weighted" });
    jevTokens += located.inputTokens;

    const { points, km } = scoreGuess(located.guess, drive.origin);
    const previous = steps[steps.length - 1];
    const movedKm = previous ? distanceKm(previous.guess, located.guess) : 0;
    const landed = countryCodeAtOffline(located.guess.lat, located.guess.lng);

    steps.push({
      photo: frame.url, at: { lat: frame.lat, lng: frame.lng }, heading: frame.heading,
      observation, guess: located.guess, km: Math.round(km), points,
      movedKm: Math.round(movedKm), landedIn: landed,
      topLabel: located.winner.label, topProbability: located.stages.at(-1)?.[0]?.probability ?? 0,
    });

    const moved = movedKm >= 1 ? `  moved ${Math.round(movedKm).toLocaleString()} km` : "";
    console.log(`  frame ${String(i + 1).padStart(2)}  ${String(Math.round(km)).padStart(5)} km off  ${String(points).padStart(4)} pts${moved}`);
    console.log(`            ${located.winner.label.slice(0, 92)}`);
  }
} catch (error) {
  if (isBudgetError(error)) throw new BudgetExhausted(String((error as Error).message));
  throw error;
}

if (!steps.length) { console.error("no frames survived"); process.exit(1); }

writeFileSync(new URL(`../${out}`, import.meta.url), JSON.stringify({
  sequenceId: drive.sequenceId,
  origin: drive.origin,
  truthCode,
  truthLabel: truthCode ? countryByCode(truthCode)?.name ?? truthCode : "unknown",
  spanKm: Number(drive.spanKm.toFixed(2)),
  steps,
}, null, 1), "utf8");

const first = steps[0]!, last = steps[steps.length - 1]!;
console.log(`\nfirst look ${first.km.toLocaleString()} km off, after ${steps.length} looks ${last.km.toLocaleString()} km off`);
console.log(`biggest single revision: ${Math.max(...steps.map((s) => s.movedKm)).toLocaleString()} km`);
console.log(`Jev ${usd(costOf("typesafe-ai/jev", { inputTokens: jevTokens, outputTokens: 0 }))}, describer ${usd(describerCost)}`);
console.log(`wrote ${out}`);
