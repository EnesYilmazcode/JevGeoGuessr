// Looking around, instead of staring at one photograph.
//
// A round of GeoGuessr is not a single frame. You are dropped somewhere, you drive down the road,
// and the thing that settles it is usually something you did not see at first: a sign two hundred
// metres on, a different style of pole, a plate you finally get close enough to read.
//
// KartaView photos come in sequences, consecutive frames from one drive, with an index and a
// heading. That is the road, and walking it is what lets a guess be revised rather than just made.

import { nearbyPhotos, type Photo } from "./kartaview.ts";
import { distanceKm, type Point } from "./geo.ts";

export type Frame = Photo;

export type Drive = {
  sequenceId: string;
  /** Frames in travel order, thinned so consecutive ones are actually somewhere different. */
  frames: Frame[];
  /** Where the round starts. Guesses are scored against this, the way a drop point is. */
  origin: Point;
  /** How far the drive covers, end to end. */
  spanKm: number;
};

/**
 * Finds the longest single drive near a point.
 *
 * Frames are thinned by distance rather than by index, because a stationary camera at a red light
 * can produce fifty consecutive frames of the same junction, and fifty looks at one junction is
 * not more evidence.
 */
export async function findDrive(
  lat: number,
  lng: number,
  { radiusM = 1000, minSpacingM = 120, maxFrames = 12 } = {},
): Promise<Drive | null> {
  // KartaView answers 400 on some dense tiles rather than returning fewer photos, so treat a
  // refusal as no coverage instead of letting it end the run.
  let photos;
  try {
    photos = await nearbyPhotos(lat, lng, radiusM);
  } catch {
    return null;
  }
  if (!photos.length) return null;

  const bySequence = new Map<string, Frame[]>();
  for (const photo of photos) {
    if (!photo.sequenceId || !Number.isFinite(photo.index)) continue;
    const list = bySequence.get(photo.sequenceId);
    if (list) list.push(photo); else bySequence.set(photo.sequenceId, [photo]);
  }
  if (!bySequence.size) return null;

  const longest = [...bySequence.values()].sort((a, b) => b.length - a.length)[0]!;
  longest.sort((a, b) => a.index - b.index);

  const kept: Frame[] = [];
  for (const frame of longest) {
    const last = kept[kept.length - 1];
    if (!last || distanceKm({ lat: last.lat, lng: last.lng }, { lat: frame.lat, lng: frame.lng }) * 1000 >= minSpacingM) {
      kept.push(frame);
    }
    if (kept.length >= maxFrames) break;
  }
  if (kept.length < 2) return null;

  const origin = { lat: kept[0]!.lat, lng: kept[0]!.lng };
  const end = { lat: kept[kept.length - 1]!.lat, lng: kept[kept.length - 1]!.lng };
  return { sequenceId: kept[0]!.sequenceId, frames: kept, origin, spanKm: distanceKm(origin, end) };
}
