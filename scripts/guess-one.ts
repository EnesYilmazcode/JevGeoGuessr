// One round against a live photo, showing the narrowing stage by stage.
//
//   npm run guess -- 48.8584 2.2945
//   npm run guess -- 35.6762 139.6503 --stages=3 --beam=3

import { nearbyPhotos, fetchImage } from "../src/kartaview.ts";
import { countryCodeAtOffline } from "../src/truth.ts";
import { observe } from "../src/observe.ts";
import { locate } from "../src/locate.ts";
import { scoreGuess, distanceKm } from "../src/geo.ts";
import { countryByCode } from "../src/countries.ts";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const [lat = NaN, lng = NaN] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map(Number);
if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error("usage: npm run guess -- <lat> <lng> [--stages=3] [--beam=3]");
  process.exit(1);
}

const photos = await nearbyPhotos(lat, lng, 1000);
if (!photos.length) { console.error("No KartaView coverage there."); process.exit(1); }

const photo = photos[Math.floor(Math.random() * photos.length)]!;
const truth = { lat: photo.lat, lng: photo.lng };
const truthCode = countryCodeAtOffline(photo.lat, photo.lng);

console.log(`photo ${photo.id} by ${photo.username}   ${photo.lat.toFixed(4)}, ${photo.lng.toFixed(4)}`);
console.log(photo.url);

const image = await fetchImage(photo);
const { observation, cached } = await observe(image, photo.id);

console.log(`\nwhat Jev is told${cached ? " (cached)" : ""}`);
for (const [key, value] of Object.entries(observation)) {
  console.log(`  ${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value).slice(0, 150)}`);
}

const located = await locate(observation, {
  stages: Number(arg("stages", "3")),
  beam: Number(arg("beam", "3")),
  aggregate: "weighted",
});

located.stages.forEach((ranking, i) => {
  console.log(`\nstage ${i + 1}, top 5 of ${ranking.length}`);
  for (const { cell, probability } of ranking.slice(0, 5)) {
    const off = Math.round(distanceKm(cell.centre, truth));
    console.log(`  ${(probability * 100).toFixed(1).padStart(5)}%  ${String(off).padStart(5)} km off   ${cell.label.slice(0, 80)}`);
  }
});

const { points, km } = scoreGuess(located.guess, truth);
const landedIn = countryCodeAtOffline(located.guess.lat, located.guess.lng);

console.log(`\npin at ${located.guess.lat.toFixed(3)}, ${located.guess.lng.toFixed(3)}`);
console.log(`truth ${truthCode ? countryByCode(truthCode)?.name ?? truthCode : "unknown"}   pin landed in ${landedIn ? countryByCode(landedIn)?.name ?? landedIn : "open water"}`);
console.log(`${Math.round(km)} km   ${points} points`);
console.log(`${located.calls} Jev calls, ${located.inputTokens.toLocaleString()} tokens, ${located.ms} ms`);
