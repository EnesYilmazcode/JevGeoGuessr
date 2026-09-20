// Gateway list prices, in dollars per token, read off https://ai-gateway.vercel.sh/v1/models.
// Kept here so every cost printed by the benchmark is arithmetic on real numbers, not an estimate.

export const PRICING = {
  "typesafe-ai/jev": { input: 0.000000042, output: 0 },
  "google/gemini-3.5-flash": { input: 0.0000015, output: 0.000009 },
} as const;

export type Usage = { inputTokens: number; outputTokens: number };

export const costOf = (model: keyof typeof PRICING, usage: Usage): number =>
  usage.inputTokens * PRICING[model].input + usage.outputTokens * PRICING[model].output;

export const usd = (n: number): string =>
  n >= 0.01 ? `$${n.toFixed(2)}` : n >= 0.0001 ? `$${n.toFixed(5)}` : `$${n.toExponential(2)}`;
