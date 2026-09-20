// Distance and scoring. This is the only place the true location is allowed to be touched,
// and nothing here ever feeds back into a guess.

export type Point = { lat: number; lng: number };

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// GeoGuessr's own curve: 5000 points at zero distance, decaying against the diagonal of the map.
// The world map's diagonal is 14916.862 km, so a guess on the wrong continent is worth almost nothing.
const WORLD_MAP_SIZE_KM = 14916.862;

export function scoreGuess(guess: Point, truth: Point): { points: number; km: number } {
  const km = distanceKm(guess, truth);
  return { points: Math.round(5000 * Math.exp((-10 * km) / WORLD_MAP_SIZE_KM)), km };
}
