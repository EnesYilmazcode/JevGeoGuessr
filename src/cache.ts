// A disk cache for observations, keyed by photo AND by the exact describer that produced it.
//
// Why it matters: the describer is 99% of the cost of a round and almost all of its wall clock.
// Cached, an experiment that only changes how Jev is asked replays 300 photos in seconds for
// fractions of a cent, so it is cheap to check whether a change actually helped.
//
// Why the key includes the describer: if it were the photo alone, editing the instructions would
// silently replay observations written by the old ones, and the comparison would be meaningless.
// Any change to the model, the instructions or the schema produces a different key.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../data/observations", import.meta.url));

export const describerVersion = (model: string, instructions: string, fields: string[]): string =>
  createHash("sha256").update([model, instructions, ...fields].join("\u0000")).digest("hex").slice(0, 10);

const pathFor = (version: string, photoId: string) => `${DIR}/${version}-${photoId}.json`;

export function readCached<T>(version: string, photoId: string): T | null {
  const file = pathFor(version, photoId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null; // a half written file from an interrupted run; treat it as a miss
  }
}

export function writeCached(version: string, photoId: string, value: unknown): void {
  mkdirSync(DIR, { recursive: true });
  const file = pathFor(version, photoId);
  // Write then rename, so an interrupted run cannot leave a truncated entry behind.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), "utf8");
  try {
    renameSync(temp, file);
  } catch {
    writeFileSync(file, JSON.stringify(value), "utf8");
  }
}

export function cacheStats(version: string): { entries: number } {
  if (!existsSync(DIR)) return { entries: 0 };
  return { entries: readdirSync(DIR).filter((f) => f.startsWith(`${version}-`)).length };
}
