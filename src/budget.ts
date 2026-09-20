// Spend checks.
//
// A comparison run once reported a confident table over 23 photos while silently discarding the
// other 137, because every one of those failed with "API key budget exceeded" and the loop counted
// them as generic errors and carried on. A run that quietly drops most of its data and still prints
// a result is worse than one that crashes, so budget failures now stop everything, and a run says
// what it can afford before it starts.

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/credits";

export type Credits = { balance: number; used: number };

export async function credits(): Promise<Credits | null> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { balance?: string; total_used?: string };
    return { balance: Number(json.balance ?? 0), used: Number(json.total_used ?? 0) };
  } catch {
    return null;
  }
}

/** True when the provider is refusing because of spend rather than anything about the request. */
export const isBudgetError = (error: unknown): boolean =>
  /budget exceeded|insufficient (credit|funds)|quota exceeded|payment required/i
    .test(String((error as Error)?.message ?? error));

export class BudgetExhausted extends Error {
  constructor(message: string) {
    super(`Spend limit reached, stopping the run rather than reporting a partial result.\n${message}`);
  }
}

/** Prints what the account has before a run, so an empty table is never a surprise. */
export async function reportCredits(estimate?: number): Promise<void> {
  const c = await credits();
  if (!c) return;
  console.log(`account credit $${c.balance.toFixed(2)} remaining, $${c.used.toFixed(2)} used so far`);
  if (estimate !== undefined) console.log(`this run should cost about $${estimate.toFixed(2)}`);
  console.log("note: an individual key can also carry its own spend limit, which this cannot see");
}
