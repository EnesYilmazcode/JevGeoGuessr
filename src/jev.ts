// Jev's half. It never sees the photograph, only the observation, and it never writes a word:
// it is handed the 194 country menu and returns a probability for every one of them.

import { experimental_evaluate as evaluate } from "ai";
import { COUNTRIES, countryByCode, type Country } from "./countries.ts";
import type { Observation } from "./observe.ts";

export const JEV_MODEL = "typesafe-ai/jev";

export type Ranking = { country: Country; probability: number }[];

export type JevResult = {
  ranking: Ranking;
  top: Country;
  inputTokens: number;
  ms: number;
};

const INSTRUCTIONS =
  "Choose the country where this photograph was most likely taken. Weigh which side of the road traffic uses, " +
  "the script and wording of any copied text, the shape and colouring of licence plates, the style of poles, " +
  "bollards and road markings, the building materials and roof forms, the plant species implied by the described " +
  "foliage, the soil colour, and the sun height, against each other rather than relying on any single one.";

// Jev's service fails in two transient ways: 503 "temporarily unavailable" in short bursts, and
// 504 timeouts when the request is large, which accumulated evidence makes more likely. The
// gateway marks both retryable and says so; trust that rather than matching on a status alone.
const transient = (error: unknown): boolean => {
  const e = error as { statusCode?: number; isRetryable?: boolean; message?: string };
  if (e?.isRetryable) return true;
  if (e?.statusCode === 503 || e?.statusCode === 504) return true;
  return /temporarily unavailable|timed out|timeout|internal server error/i.test(String(e?.message ?? error));
};

async function withRetry<T>(call: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!transient(error) || attempt >= attempts) throw error;
      // Timeouts need real backoff, not the 200ms jitter a 503 burst wants.
      const base = (error as { statusCode?: number })?.statusCode === 504 ? 1200 : 150;
      await new Promise((r) => setTimeout(r, base + Math.random() * 250 + attempt * base));
    }
  }
}

export async function rankCountries(observation: Observation): Promise<JevResult> {
  const criteria = Object.fromEntries(
    COUNTRIES.map((c) => [c.code, `The photograph was taken in ${c.name}.`]),
  );
  const started = Date.now();
  const result = await withRetry(() => evaluate({
    model: JEV_MODEL,
    state: {
      task: "Geolocating one street level photograph from a written record of what is physically visible in it.",
      observation,
      note: "The record was written by someone forbidden to name any place, nationality or language. Copied sign text is the one exception and appears exactly as it was printed.",
    },
    questions: { country: { type: "choice" as const, instructions: INSTRUCTIONS, criteria } },
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000),
  }));

  const answer = result.answers.country;
  if (answer.type !== "choice") throw new Error("Jev returned the wrong answer type.");
  const probabilities = answer.probabilities ?? { [answer.choice]: 1 };

  const ranking: Ranking = COUNTRIES
    .map((country) => ({ country, probability: probabilities[country.code] ?? 0 }))
    .sort((a, b) => b.probability - a.probability);

  const top = countryByCode(answer.choice) ?? ranking[0]!.country;
  return { ranking, top, inputTokens: result.usage.inputTokens ?? 0, ms: Date.now() - started };
}
