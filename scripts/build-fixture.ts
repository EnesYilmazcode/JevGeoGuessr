// Builds web/drive.sample.json: a rendering fixture, so the video pipeline can be exercised and
// reviewed without an API key.
//
// The photographs and their coordinates are real, pulled from a real KartaView drive. The pins are
// NOT Jev's: they are a scripted path standing in for a guess that corrects itself, purely so the
// animation has something to move. The file is marked `fixture: true` and the renderer is never
// given it by default. Nothing here may be quoted as a result.

import { writeFileSync } from "node:fs";
import { findDrive } from "../src/sequence.ts";
import { scoreGuess, distanceKm } from "../src/geo.ts";
import { countryCodeAtOffline } from "../src/truth.ts";
import { countryByCode } from "../src/countries.ts";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const [lat = 48.8584, lng = 2.2945] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(Number);

const drive = await findDrive(lat, lng, { maxFrames: Number(arg("frames", "8")) });
if (!drive) throw new Error("no drive there");

const truthCode = countryCodeAtOffline(drive.origin.lat, drive.origin.lng);

// A stand-in path: start on the wrong continent, cross to roughly the right one, then close in.
// Shaped to exercise the renderer's big-correction case, which is the frame that has to read.
const path = [
  { lat: 39.0, lng: -98.0 },
  { lat: 45.0, lng: 9.0 },
  { lat: 47.5, lng: 3.0 },
  { lat: 48.4, lng: 2.6 },
  { lat: 48.75, lng: 2.4 },
  { lat: 48.84, lng: 2.33 },
  { lat: 48.855, lng: 2.30 },
  { lat: 48.858, lng: 2.297 },
];

const steps = drive.frames.map((frame, i) => {
  const guess = path[Math.min(i, path.length - 1)]!;
  const previous = i > 0 ? path[Math.min(i - 1, path.length - 1)]! : guess;
  const { points, km } = scoreGuess(guess, drive.origin);
  return {
    photo: frame.url,
    at: { lat: frame.lat, lng: frame.lng },
    heading: frame.heading,
    guess,
    km: Math.round(km),
    points,
    movedKm: Math.round(distanceKm(previous, guess)),
    landedIn: countryCodeAtOffline(guess.lat, guess.lng),
    topLabel: "fixture",
    topProbability: 0,
  };
});

const names: Record<string, string> = {};
for (const step of steps) {
  if (step.landedIn && !names[step.landedIn]) names[step.landedIn] = countryByCode(step.landedIn)?.name ?? step.landedIn;
}

writeFileSync(new URL("../web/drive.sample.json", import.meta.url), JSON.stringify({
  fixture: true,
  note: "Photographs and coordinates are real. The pins are scripted, not Jev's. Not a result.",
  sequenceId: drive.sequenceId,
  origin: drive.origin,
  truthCode,
  truthLabel: truthCode ? countryByCode(truthCode)?.name ?? truthCode : "unknown",
  spanKm: Number(drive.spanKm.toFixed(2)),
  names,
  steps,
}, null, 1), "utf8");

console.log(`wrote web/drive.sample.json: ${steps.length} real frames, scripted pins`);
