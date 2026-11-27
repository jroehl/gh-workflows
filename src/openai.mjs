import { MAX_TOKENS, costOf, estimateInputTokens } from "./cost.mjs";
import { emptyAnswer, redact, transportError } from "./errors.mjs";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
// Node's fetch (undici) has its own 300 s headersTimeout, which fires before this when
// no response headers arrive; changing it would need undici as a dependency, so it stays.
const TIMEOUT_MS = 15 * 60_000;

// The error.code values developers.openai.com/api/docs/guides/error-codes lists for a
// spent credit or a spend/usage limit, all 429. insufficient_quota is the older code and
// still the error.type of these. None of them clears by retrying, so the next link runs.
const CREDIT_CODES = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

function classify(status, error) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) {
    return CREDIT_CODES.has(error?.code) || error?.type === "insufficient_quota" ? "credit_exhausted" : "rate_limit";
  }
  if (status >= 500) return "unavailable";
  return "http";
}

// The ChatGPT-included API credit, through chat completions. OpenAI has no max_price,
// so the budget bounds the call by max_completion_tokens alone, which (like OpenRouter's
// max_tokens) caps reasoning plus content. No error from here is fatal: an empty credit
// pool or a dead key moves the chain on to OpenRouter, and the caller makes a rejected
// key loud.
export async function completeOpenAI({ model, entry, system, user, maxTokens = MAX_TOKENS, budget, stage }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw transportError("openai", "no_key", "OPENAI_API_KEY is not set");
  const apiModel = entry?.api_model ?? model.slice(model.indexOf(":") + 1);
  if (budget && entry) ({ maxTokens } = budget.plan({ entry, system, user, stage }));

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: apiModel,
        max_completion_tokens: maxTokens,
        // JSON mode, not json_schema: one prompt and one answer shape for every
        // transport, validated by the critic and refuter wrappers either way.
        response_format: { type: "json_object" },
        messages: [
          { role: "developer", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (budget && entry) budget.debitReserved({ entry, system, user, maxTokens, stage });
    throw transportError("openai", e.name === "TimeoutError" ? "timeout" : "network", `OpenAI ${model}: ${e.message}`);
  }

  if (!res.ok) {
    const raw = await res.text();
    let error = null;
    try {
      error = JSON.parse(raw).error ?? null;
    } catch {
      /* not JSON */
    }
    const code = classify(res.status, error);
    throw transportError("openai", code, `OpenAI ${res.status} (${code}): ${redact(raw.slice(0, 400))}`);
  }

  const body = await res.json();
  const choice = body.choices?.[0];
  const text = choice?.message?.content;
  const usage = body.usage ?? {};
  // OpenAI reports tokens, not money: the cost is the registry's list price for them.
  const { cost, estimated } = costOf(usage, entry, {
    input: estimateInputTokens(system, user),
    output: estimateInputTokens(text ?? ""),
  });
  if (budget) budget.debit(stage, cost, estimated);
  if (!text) throw emptyAnswer(model, choice?.finish_reason === "length", choice?.finish_reason, maxTokens);
  return { text, usage, cost, estimated, model, paid_by: "openai-credit" };
}
