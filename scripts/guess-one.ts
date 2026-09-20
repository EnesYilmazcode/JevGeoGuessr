// One round against a live photo. Usage: npm run guess -- <lat> <lng>
import { nearbyPhotos } from "../src/kartaview.ts";
import { countryCodeAtOffline } from "../src/truth.ts";
import { playRound } from "../src/guess.ts";
import { countryByCode } from "../src/countries.ts";

process.loadEnvFile(new URL("../.env", import.meta.url).pathname.slice(1));

const [lat = NaN, lng = NaN] = process.argv.slice(2).map(Number);
if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
  console.error("usage: npm run guess -- <lat> <lng>");
  process.exit(1);
}

const photos = await nearbyPhotos(lat, lng, 3000);
if (!photos.length) { console.error("No KartaView coverage there."); process.exit(1); }

const photo = photos[Math.floor(Math.random() * photos.length)]!;
const truthCode = countryCodeAtOffline(photo.lat, photo.lng);

console.log(`photo ${photo.id} by ${photo.username}  ${photo.lat.toFixed(4)}, ${photo.lng.toFixed(4)}`);
console.log(photo.url);

const round = await playRound(photo, truthCode);

console.log("\nobservation");
for (const [k, v] of Object.entries(round.observation)) {
  console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
}

console.log("\nJev's top 8 of 194");
for (const { country, probability } of round.ranking.slice(0, 8)) {
  const bar = "#".repeat(Math.round(probability * 40));
  console.log(`  ${(probability * 100).toFixed(1).padStart(5)}%  ${country.name.padEnd(22)} ${bar}`);
}

const truth = truthCode ? countryByCode(truthCode)?.name ?? truthCode : "unknown";
console.log(`\ntruth ${truth}   guess ${round.guess.name}   ${round.correct ? "HIT" : "MISS"}`);
console.log(`rank of truth ${round.rankOfTruth ?? "?"}/194   ${Math.round(round.km)} km   ${round.points} points`);
console.log(`signs named a place: ${round.signsNamedAPlace}   jev ${round.jevMs}ms ${round.jevTokens} tokens   round ${(round.totalMs / 1000).toFixed(1)}s`);
