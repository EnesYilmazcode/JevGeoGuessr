// Ground truth: which country a photo's coordinates actually fall in.
// Only the benchmark touches this. It is never shown to the describer or to Jev.
//
// Nominatim asks for one request a second and a real User-Agent, so honour both. Truth is resolved
// once while the test set is built and then cached in data/testset.json, never during a run.

const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "JevGeoGuessr/0.1 (https://github.com/EnesYilmazcode/JevGeoGuessr)";

let nextSlot = 0;
async function rateLimited<T>(call: () => Promise<T>): Promise<T> {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Date.now() + wait + 1100;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  return call();
}

/** ISO 3166-1 alpha-2 for a coordinate, or null when it falls outside any country. */
export async function countryCodeAt(lat: number, lng: number): Promise<string | null> {
  return rateLimited(async () => {
    const url = `${ENDPOINT}?format=jsonv2&zoom=3&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const json = await res.json() as { address?: { country_code?: string } };
    return json.address?.country_code?.toUpperCase() ?? null;
  });
}
