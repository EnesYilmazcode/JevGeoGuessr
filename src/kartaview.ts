// Photos come from KartaView: open street level imagery, CC-BY-SA, no API key and no billing.
// That matters twice over. It costs nothing to run, and unlike Street View the images can be
// redistributed, so the test set in data/ is something anyone can rebuild and check.

export type Photo = {
  id: string;
  lat: number;
  lng: number;
  heading: number | null;
  /** Which drive this frame came from, and where in it. Consecutive frames are consecutive road. */
  sequenceId: string;
  index: number;
  shotDate: string | null;
  username: string;
  url: string;
};

const NEARBY = "https://api.openstreetcam.org/1.0/list/nearby-photos/";
const STORAGE = "https://api.openstreetcam.org/";

type RawPhoto = {
  id: string; lat: string; lng: string; name: string;
  heading: string | null; shot_date: string | null; username: string; projection: string;
  sequence_id: string; sequence_index: string;
};

const toPhoto = (r: RawPhoto): Photo => ({
  id: r.id,
  lat: Number(r.lat),
  lng: Number(r.lng),
  sequenceId: String(r.sequence_id ?? ""),
  index: Number(r.sequence_index ?? 0),
  heading: r.heading == null ? null : Number(r.heading),
  shotDate: r.shot_date,
  username: r.username,
  url: STORAGE + r.name,
});

/** Every photo KartaView holds within `radiusM` of a point. Empty over ocean and over gaps in coverage. */
export async function nearbyPhotos(lat: number, lng: number, radiusM = 5000): Promise<Photo[]> {
  const res = await fetch(NEARBY, {
    method: "POST",
    body: new URLSearchParams({ lat: String(lat), lng: String(lng), radius: String(radiusM) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`KartaView ${res.status}`);
  const json = await res.json() as { currentPageItems?: RawPhoto[] };
  return (json.currentPageItems ?? [])
    // 360 panoramas come back warped as a flat JPEG, which is its own puzzle. Keep to plain frames.
    .filter((r) => r.projection === "PLANE")
    .map(toPhoto);
}

// The storage tier answers 409 and 5xx now and then on a photo that serves fine a moment later.
export async function fetchImage(photo: Photo, attempts = 4): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(photo.url, { signal: AbortSignal.timeout(60_000) });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (attempt >= attempts || (res.status !== 409 && res.status < 500)) {
      throw new Error(`photo ${photo.id}: HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
}
