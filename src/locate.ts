// Guessing a location instead of a country, by narrowing.
//
// Pick a region of the world, then a region inside that one, then a town. Each stage is the same
// trick as before: build a menu, let Jev score every option, take what it picked. The menu just
// gets smaller and more specific each time.
//
// Two things here matter more than they look.
//
// The pin does not have to go on the winning option. When the evidence in a photograph genuinely
// points at a border region, Jev splits its probability across the cells either side, and the
// honest place for the pin is between them. So the guess can be the probability weighted centre of
// the whole distribution rather than the top pick, which is the thing a distance-scored game
// actually rewards. Both are implemented; the benchmark measures which wins.
//
// And averaging positions on a sphere is not averaging two numbers. Longitudes either side of the
// antimeridian average to the wrong side of the planet, so the mean is taken over unit vectors.

import { experimental_evaluate as evaluate } from "ai";
import { partition, placeCells, places, type Cell, type Place } from "./cells.ts";
import type { Observation } from "./observe.ts";
import type { Point } from "./geo.ts";

export const JEV_MODEL = "typesafe-ai/jev";

// Measured, not guessed: 255 options succeed and 256 is refused with "TypeSafe Choice questions
// support at most 255 options." A 255 option call costs about 7,000 tokens and still answers in
// under a second.
const MAX_OPTIONS = 255;

// Cells come from binary splits, so a stage holds a power of two. 128 fits inside the cap with room
// for the labels to grow; 256 would not fit at all.
const SPLIT_DEPTH = 7;

export type StageRanking = { cell: Cell; probability: number }[];

export type Located = {
  guess: Point;
  /** The option that led, so a render can say which town it settled on. */
  winner: Cell;
  /** One ranking per stage, coarsest first. */
  stages: StageRanking[];
  inputTokens: number;
  calls: number;
  ms: number;
};

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Mean of positions on a sphere. Averaging the raw numbers breaks across the antimeridian. */
export function weightedCentre(points: { point: Point; weight: number }[]): Point {
  let x = 0, y = 0, z = 0, total = 0;
  for (const { point, weight } of points) {
    if (weight <= 0) continue;
    const lat = rad(point.lat), lng = rad(point.lng);
    x += Math.cos(lat) * Math.cos(lng) * weight;
    y += Math.cos(lat) * Math.sin(lng) * weight;
    z += Math.sin(lat) * weight;
    total += weight;
  }
  if (!total) return { lat: 0, lng: 0 };
  x /= total; y /= total; z /= total;
  const hyp = Math.sqrt(x * x + y * y);
  // Everything cancelled: the weights point at opposite sides of the planet. No mean is meaningful.
  if (hyp < 1e-9 && Math.abs(z) < 1e-9) return points[0]!.point;
  return { lat: deg(Math.atan2(z, hyp)), lng: deg(Math.atan2(y, x)) };
}

const unavailable = (error: unknown) =>
  (error as { statusCode?: number })?.statusCode === 503 || /temporarily unavailable/i.test(String(error));

async function withRetry<T>(call: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!unavailable(error) || attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 250 + attempt * 150));
    }
  }
}

const INSTRUCTIONS = (stage: number, last: boolean) => last
  ? "Choose the settlement this photograph was most likely taken in or beside. Weigh the copied text, " +
    "which side of the road traffic uses, licence plate colouring, pole and bollard style, road marking " +
    "colours, building materials and roof forms, the plants, the soil colour and the sun height."
  : `Choose the region this photograph was most likely taken in.${stage > 0 ? " These are all inside the region already chosen, so decide by the finer detail." : ""} ` +
    "Weigh which side of the road traffic uses, the script and wording of any copied text, licence plate " +
    "shape and colouring, the style of poles, bollards, guide posts and road markings, building materials " +
    "and roof forms, the plant species implied by the described foliage, the soil colour, and the sun " +
    "height, against each other rather than relying on any single one.";

async function rankCells(observation: Observation, cells: Cell[], stage: number, last: boolean) {
  const criteria = Object.fromEntries(cells.map((c) => [c.id, c.label]));
  const result = await withRetry(() => evaluate({
    model: JEV_MODEL,
    state: {
      task: "Geolocating one street level photograph from a written record of what is physically visible in it.",
      observation,
      note: "The record was written by someone forbidden to name any place, nationality or language. Copied sign text is the one exception and appears exactly as it was printed.",
    },
    questions: { where: { type: "choice" as const, instructions: INSTRUCTIONS(stage, last), criteria } },
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000),
  }));

  const answer = result.answers.where;
  if (answer.type !== "choice") throw new Error("Jev returned the wrong answer type.");
  const probabilities = answer.probabilities ?? { [answer.choice]: 1 };
  const ranking: StageRanking = cells
    .map((cell) => ({ cell, probability: probabilities[cell.id] ?? 0 }))
    .sort((a, b) => b.probability - a.probability);

  // The SDK's own argmax and the returned distribution can disagree on a near tie; trust the
  // distribution, which is the thing the rest of this reads.
  return { ranking, inputTokens: result.usage.inputTokens ?? 0 };
}

/** Builds the menu for a pool: one option per place once the pool is small, otherwise cells. */
function menuFor(pool: Place[]): { cells: Cell[]; last: boolean } {
  if (pool.length <= MAX_OPTIONS) return { cells: placeCells(pool), last: true };
  return { cells: partition(pool, SPLIT_DEPTH), last: false };
}

export type LocateOptions = {
  stages?: number;
  aggregate?: "weighted" | "argmax";
  /**
   * How many regions to carry into the next stage. One is greedy narrowing, and the oracle shows
   * greedy can lose: committing to a single region at one stage can put the right answer out of
   * reach at the next, and no later judgement recovers it. Carrying two or three keeps the
   * alternative alive at the cost of one extra Jev call per stage, which is a quarter of a second.
   */
  beam?: number;
  /**
   * Stop narrowing when the leading region is not convincing. Splitting a region the model is not
   * sure about just moves the pin somewhere more specific and more wrong.
   */
  minConfidence?: number;
};

export async function locate(
  observation: Observation,
  { stages = 2, aggregate = "weighted", beam = 1, minConfidence = 0 }: LocateOptions = {},
): Promise<Located> {
  const started = Date.now();
  let inputTokens = 0, calls = 0;

  // Each frontier entry is a region still in play, carrying the probability of having got here.
  let frontier: { pool: Place[]; weight: number }[] = [{ pool: places(), weight: 1 }];
  const trail: StageRanking[] = [];
  let distribution: { point: Point; weight: number }[] = [];
  let leader: { cell: Cell; weight: number } | null = null;

  for (let stage = 0; stage < stages; stage += 1) {
    const candidates: { cell: Cell; weight: number; exhausted: boolean }[] = [];

    for (const node of frontier) {
      const { cells, last } = menuFor(node.pool);
      if (cells.length < 2) {
        candidates.push({ cell: cells[0]!, weight: node.weight, exhausted: true });
        continue;
      }
      const { ranking, inputTokens: used } = await rankCells(observation, cells, stage, last);
      inputTokens += used;
      calls += 1;
      for (const r of ranking) {
        // Chain rule: how likely this region is, given how likely its parent was.
        candidates.push({ cell: r.cell, weight: node.weight * r.probability, exhausted: last || r.cell.places.length <= 1 });
      }
    }

    candidates.sort((a, b) => b.weight - a.weight);
    distribution = candidates.map((c) => ({ point: c.cell.centre, weight: c.weight }));
    leader = candidates[0]!;
    // Record the merged view across every branch, so the trail is the same shape whatever the
    // beam width. The replay page reads this.
    trail.push(candidates.map((c) => ({ cell: c.cell, probability: c.weight })));

    const survivors = candidates.filter((c) => !c.exhausted).slice(0, Math.max(1, beam));
    if (!survivors.length) break;
    if (leader.weight < minConfidence) break;

    frontier = survivors.map((c) => ({ pool: c.cell.places, weight: c.weight }));
  }

  if (!leader) throw new Error("no stage produced a ranking");

  const guess = aggregate === "argmax"
    ? leader.cell.centre
    // Hedge across the final distribution. If the photograph really is ambiguous between two sides
    // of a border, the pin belongs between them, and distance scoring pays for that.
    : weightedCentre(distribution);

  return { guess, winner: leader.cell, stages: trail, inputTokens, calls, ms: Date.now() - started };
}
