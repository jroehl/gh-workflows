// Output tokens a call may produce at most. The budget is shared with reasoning, so
// this is the ceiling that keeps reasoning models from ending on an empty answer;
// see CLAUDE.md.
export const MAX_TOKENS = 32_000;
// Below this a reasoning model is likely to think its way to an empty answer, which
// would be paid for and then fail. Skipping the call is cheaper and says why.
export const MIN_TOKENS = 4_000;

const usd = (n) => `$${n.toFixed(2)}`;

// A token is about four characters of code or English. Only used to reserve input
// cost before the call; the real figure comes back in usage.
export function estimateInputTokens(...texts) {
  return Math.ceil(texts.reduce((n, t) => n + (t?.length ?? 0), 0) / 4);
}

export function costOf(usage, entry, fallbackTokens = {}) {
  if (typeof usage?.cost === "number") return { cost: usage.cost, estimated: false };
  if (entry?.in_usd_per_m == null || entry?.out_usd_per_m == null) return { cost: 0, estimated: true };
  const input = usage?.prompt_tokens ?? fallbackTokens.input ?? 0;
  const output = usage?.completion_tokens ?? fallbackTokens.output ?? 0;
  return { cost: (input * entry.in_usd_per_m + output * entry.out_usd_per_m) / 1e6, estimated: true };
}

export class CostCapError extends Error {
  constructor(message) {
    super(message);
    this.code = "cost_cap";
  }
}

export class Budget {
  constructor(max) {
    this.max = max;
    this.by = { critic: 0, fallback: 0, refuter: 0 };
    this.estimated = false;
    this.lastStage = null;
  }

  get spent() {
    return this.by.critic + this.by.fallback + this.by.refuter;
  }

  remaining() {
    return this.max - this.spent;
  }

  debit(stage, cost, estimated) {
    this.by[stage] = (this.by[stage] ?? 0) + cost;
    if (estimated) this.estimated = true;
    this.lastStage = stage;
  }

  trip(stage) {
    const where = this.lastStage ? `after ${this.lastStage}` : `before ${stage}`;
    return new CostCapError(`cost cap ${usd(this.max)} reached ${where}`);
  }

  // Sizes one call so that it cannot take the run past the cap: the prompt is priced
  // first at the input rate, and what is left bounds max_tokens at the output rate.
  plan({ entry, system, user, stage }) {
    const remaining = this.remaining();
    if (remaining <= 0) throw this.trip(stage);
    if (entry.in_usd_per_m == null || entry.out_usd_per_m == null) {
      // An unlisted model (--allow-any-model): nothing to size it with.
      return { maxTokens: MAX_TOKENS, maxPrice: null };
    }
    const maxPrice = { prompt: entry.in_usd_per_m, completion: entry.out_usd_per_m };
    if (entry.out_usd_per_m === 0) return { maxTokens: MAX_TOKENS, maxPrice };
    const inputCost = (estimateInputTokens(system, user) * entry.in_usd_per_m) / 1e6;
    const left = remaining - inputCost;
    if (left <= 0) throw this.trip(stage);
    const maxTokens = Math.min(MAX_TOKENS, Math.floor((left * 1e6) / entry.out_usd_per_m));
    if (maxTokens < MIN_TOKENS) throw this.trip(stage);
    return { maxTokens, maxPrice };
  }

  summary() {
    return {
      ...this.by,
      total: this.spent,
      currency: "USD",
      estimated: this.estimated,
    };
  }
}
