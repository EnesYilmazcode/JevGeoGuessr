// Builds data/places.json: every settlement over 15,000 people, with population.
//
// The seed city list has no population field, so it cannot tell Buenos Aires from a hamlet. That is
// fine for picking somewhere to look for a photo and useless for labelling a region: a menu option
// reading "the area around Vila" means nothing to anyone, and a cell has to be described by places
// that can actually be placed.
//
// GeoNames ships this only as a zip, so there is a small zip reader below rather than a dependency
// or a shell out to whatever unzip happens to exist on the machine.

import { writeFileSync } from "node:fs";

const SOURCE = "https://download.geonames.org/export/dump/cities15000.zip";

// --- minimal zip reader -----------------------------------------------------------------------
// Reads the central directory rather than streaming local headers, because entries written with a
// data descriptor carry zero sizes in the local header and only the central directory is reliable.

const u16 = (b: DataView, o: number) => b.getUint16(o, true);
const u32 = (b: DataView, o: number) => b.getUint32(o, true);

async function unzipFirstEntry(buffer: ArrayBuffer): Promise<string> {
  const view = new DataView(buffer);

  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0 && i > buffer.byteLength - 66_000; i -= 1) {
    if (u32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end of central directory record");

  const entries = u16(view, eocd + 10);
  if (!entries) throw new Error("zip has no entries");
  let p = u32(view, eocd + 16);

  if (u32(view, p) !== 0x02014b50) throw new Error("bad central directory signature");
  const method = u16(view, p + 10);
  const compressedSize = u32(view, p + 20);
  const nameLen = u16(view, p + 28);
  const extraLen = u16(view, p + 30);
  const commentLen = u16(view, p + 32);
  const localOffset = u32(view, p + 42);
  const name = new TextDecoder().decode(new Uint8Array(buffer, p + 46, nameLen));
  p += 46 + nameLen + extraLen + commentLen;

  if (u32(view, localOffset) !== 0x04034b50) throw new Error("bad local header signature");
  const localNameLen = u16(view, localOffset + 26);
  const localExtraLen = u16(view, localOffset + 28);
  const start = localOffset + 30 + localNameLen + localExtraLen;
  const data = new Uint8Array(buffer, start, compressedSize);

  console.log(`  entry ${name}, ${(compressedSize / 1024 / 1024).toFixed(1)} MB compressed, method ${method}`);

  if (method === 0) return new TextDecoder("utf-8").decode(data);
  if (method !== 8) throw new Error(`unsupported zip compression method ${method}`);

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}
// --- end zip reader ---------------------------------------------------------------------------

export type Place = {
  name: string; lat: number; lng: number; country: string; admin1: string; population: number;
};

console.log("downloading cities15000...");
const buffer = await (await fetch(SOURCE, { signal: AbortSignal.timeout(300_000) })).arrayBuffer();
const text = await unzipFirstEntry(buffer);

const places: Place[] = [];
for (const line of text.split("\n")) {
  if (!line) continue;
  const f = line.split("\t");
  const lat = Number(f[4]), lng = Number(f[5]), population = Number(f[14]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !f[1] || !f[8]) continue;
  places.push({
    name: f[2] || f[1], // ascii name, so a label is readable everywhere
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4)),
    country: f[8],
    admin1: f[10] ?? "",
    population: Number.isFinite(population) ? population : 0,
  });
}

places.sort((a, b) => b.population - a.population);
writeFileSync(new URL("../data/places.json", import.meta.url), JSON.stringify(places), "utf8");

const countries = new Set(places.map((p) => p.country));
console.log(`wrote ${places.length} places across ${countries.size} countries`);
console.log(`largest: ${places.slice(0, 5).map((p) => `${p.name} (${(p.population / 1e6).toFixed(1)}M)`).join(", ")}`);
