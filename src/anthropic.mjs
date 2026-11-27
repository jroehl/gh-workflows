import { MAX_TOKENS, costOf, estimateInputTokens } from "./cost.mjs";
import { emptyAnswer, redact, transportError } from "./errors.mjs";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
// platform.claude.com/docs/en/api/versioning, checked 2026-11-27. This version removed
// temperature/top_p/top_k, which are never sent anyway.
const VERSION = "2026-10-21";
// Node's fetch (undici) has its own 300 s headersTimeout, which fires before this when
// no response headers arrive; changing it would need undici as a dependency, so it stays.
const TIMEOUT_MS = 15 * 60_000;

// platform.claude.com/docs/en/api/errors: a spent credit or a spend limit shows as a
// 400 invalid_request_error whose message says so, a 402 billing_error, or a 429 with
// error.details.error_code enforced_spend_limit_reached. Each moves the chain on.
function classify(status, error) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || error?.type === "billing_error") return "credit_exhausted";
  if (status === 400 && /credit balance|spend limit|billing/i.test(error?.message ?? "")) return "credit_exhausted";
  if (status === 429) {
    return error?.details?.error_code === "enforced_spend_limit_reached" ? "credit_exhausted" : "rate_limit";
  }
  if (status === 529 || error?.type === "overloaded_error") return "overloaded";
  if (status >= 500) return "unavailable";
  return "http";
}

// The plan-included Claude API credit, through the Messages API. The answer is held to
// the role's JSON schema with structured outputs (output_config.format), which current
// models support without a beta header. Adaptive thinking may put a thinking block
// before the text, so the text blocks are picked out by type.
export async function completeAnthropic({ model, entry, system, user, schema, maxTokens = MAX_TOKENS, budget, stage }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw transportError("anthropic", "no_key", "ANTHROPIC_API_KEY is not set");
  const apiModel = entry?.api_model ?? model.slice(model.indexOf(":") + 1);
  if (budget && entry) ({ maxTokens } = budget.plan({ entry, system, user, stage }));

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": VERSION, "content-type": "application/json" },
      body: JSON.stringify({
        model: apiModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (budget && entry) budget.debitReserved({ entry, system, user, maxTokens, stage });
    throw transportError("anthropic", e.name === "TimeoutError" ? "timeout" : "network", `Anthropic ${model}: ${e.message}`);
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
    throw transportError("anthropic", code, `Anthropic ${res.status} (${code}): ${redact(raw.slice(0, 400))}`);
  }

  const body = await res.json();
  const text = (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const usage = {
    ...(body.usage ?? {}),
    prompt_tokens: body.usage?.input_tokens,
    completion_tokens: body.usage?.output_tokens,
  };
  const { cost, estimated } = costOf(usage, entry, {
    input: estimateInputTokens(system, user),
    output: estimateInputTokens(text),
  });
  if (budget) budget.debit(stage, cost, estimated);
  if (!text) throw emptyAnswer(model, body.stop_reason === "max_tokens", body.stop_reason, maxTokens);
  if (body.stop_reason === "refusal") {
    throw transportError("anthropic", "refusal", `${model} refused: ${text.slice(0, 200)}`);
  }
  return { text, usage, cost, estimated, model, paid_by: "anthropic-credit" };
}
