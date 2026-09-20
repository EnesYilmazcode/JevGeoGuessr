// What the score would be without Jev.
//
// "1 of 7 correct" means nothing on its own. It has to be read against what you would get by
// guessing, and against the best you could do while ignoring the photograph entirely, which on a
// distance-scored game is a surprisingly high bar: drop every pin in the middle of the landmass
// where most roads are and you bank a few thousand points without looking at anything.

import { COUNTRIES, countryByCode } from "./countries.ts";
import { scoreGuess, type Point } from "./geo.ts";

export type Baseline = { name: string; accuracy: number; meanPoints: number; note: string };

/** Uniform random over the menu, averaged over many draws so the number is stable. */
function randomGuess(truths: Point[], codes: string[], draws = 200): Baseline {
  let hits = 0, points = 0, n = 0;
  let state = 12345;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let d = 0; d < draws; d += 1) {
    for (let i = 0; i < truths.length; i += 1) {
      const pick = COUNTRIES[Math.floor(rand() * COUNTRIES.length)]!;
      if (pick.code === codes[i]) hits += 1;
      points += scoreGuess({ lat: pick.lat, lng: pick.lng }, truths[i]!).points;
      n += 1;
    }
  }
  return {
    name: "Random country",
    accuracy: hits / n,
    meanPoints: points / n,
    note: `uniform over 194, averaged over ${draws} draws`,
  };
}

/** The single country that scores best on this set if you never look at the photograph. */
function bestFixedGuess(truths: Point[], codes: string[]): Baseline {
  let best = { code: COUNTRIES[0]!.code, points: -1, hits: 0 };
  for (const country of COUNTRIES) {
    let points = 0, hits = 0;
    for (let i = 0; i < truths.length; i += 1) {
      points += scoreGuess({ lat: country.lat, lng: country.lng }, truths[i]!).points;
      if (country.code === codes[i]) hits += 1;
    }
    if (points > best.points) best = { code: country.code, points, hits };
  }
  return {
    name: "Best single country",
    accuracy: best.hits / truths.length,
    meanPoints: best.points / truths.length,
    note: `always ${countryByCode(best.code)?.name}, chosen with hindsight on this very set`,
  };
}

/** Guessing the country that appears most often in the set. Free information a real player lacks. */
function modalCountry(truths: Point[], codes: string[]): Baseline {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const country = countryByCode(top![0])!;
  let points = 0, hits = 0;
  for (let i = 0; i < truths.length; i += 1) {
    points += scoreGuess({ lat: country.lat, lng: country.lng }, truths[i]!).points;
    if (country.code === codes[i]) hits += 1;
  }
  return {
    name: "Most common country in the set",
    accuracy: hits / truths.length,
    meanPoints: points / truths.length,
    note: `always ${country.name}, which is ${top![1]} of ${codes.length} photos`,
  };
}

export function baselines(truths: Point[], codes: string[]): Baseline[] {
  return [randomGuess(truths, codes), modalCountry(truths, codes), bestFixedGuess(truths, codes)];
}
