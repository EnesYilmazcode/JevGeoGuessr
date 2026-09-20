// One round: photograph in, guess and score out.

import { fetchImage, type Photo } from "./kartaview.ts";
import { observe, signsNameAPlace, type Observation } from "./observe.ts";
import { rankCountries, type Ranking } from "./jev.ts";
import { scoreGuess } from "./geo.ts";
import { costOf } from "./pricing.ts";
import type { Country } from "./countries.ts";

export type Round = {
  photo: Photo;
  observation: Observation;
  ranking: Ranking;
  guess: Country;
  truthCode: string | null;
  correct: boolean | null;
  rankOfTruth: number | null;
  points: number;
  km: number;
  signsNamedAPlace: boolean;
  describerCost: number;
  jevCost: number;
  jevTokens: number;
  jevMs: number;
  totalMs: number;
};

export async function playRound(photo: Photo, truthCode: string | null): Promise<Round> {
  const started = Date.now();
  const image = await fetchImage(photo);
  const { observation, inputTokens, outputTokens } = await observe(image);
  const jev = await rankCountries(observation);

  // Jev names a country; the guess dropped on the map is that country's centroid.
  const { points, km } = scoreGuess({ lat: jev.top.lat, lng: jev.top.lng }, { lat: photo.lat, lng: photo.lng });
  const rankOfTruth = truthCode
    ? (jev.ranking.findIndex((r) => r.country.code === truthCode) + 1) || null
    : null;

  return {
    photo,
    observation,
    ranking: jev.ranking,
    guess: jev.top,
    truthCode,
    correct: truthCode ? jev.top.code === truthCode : null,
    rankOfTruth,
    points,
    km,
    signsNamedAPlace: signsNameAPlace(observation),
    describerCost: costOf("google/gemini-3.5-flash", { inputTokens, outputTokens }),
    jevCost: costOf("typesafe-ai/jev", { inputTokens: jev.inputTokens, outputTokens: 0 }),
    jevTokens: jev.inputTokens,
    jevMs: jev.ms,
    totalMs: Date.now() - started,
  };
}
