import { MAX_TOKENS, costOf, estimateInputTokens } from "./cost.mjs";
import { completeOpenAI } from "./openai.mjs";
import { completeAnthropic } from "./anthropic.mjs";
import { completeCodex } from "./codex.mjs";
import { emptyAnswer, redact, transportError } from "./errors.mjs";

export { parseJson } from "./errors.mjs";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// One call, routed by the model ID's prefix: openai: and anthropic: go to the vendors'
// own APIs on credit, codex: to the local codex CLI on the subscription, and a bare
// vendor/model ID to OpenRouter. Every transport returns the same shape, so the critic
// and refuter do not know which one answered.
export async function complete(opts) {
  const m = /^([a-z0-9-]+):/.exec(opts.model);
  switch (m?.[1]) {
    case undefined:
      return completeOpenRouter(opts);
    case "openai":
      return completeOpenAI(opts);
    case "anthropic":
      return completeAnthropic(opts);
    case "codex":
      return completeCodex(opts);
    default:
      throw new Error(`${opts.model}: no transport for prefix "${m[1]}:"`);
  }
}

// Reasoning models degrade when pinned to temperature 0, so temperature is never
// sent and the model's own default stands.
//
// The budget is shared with reasoning tokens. At 8000, gpt-5.1-codex spent the whole
// allowance thinking, was cut off before writing a character, and returned an empty
// string that read exactly like a clean review. OpenRouter bills tokens actually
// produced, so a ceiling this high costs nothing until something needs it.
//
// With a budget, the call is sized by it first (see Budget.plan), and what the call
// cost is debited before the answer goes back to be parsed: a billed answer that
// later fails its JSON or shape check still counts toward the cap.
export async function completeOpenRouter({ model, system, user, maxTokens = MAX_TOKENS, entry, budget, stage }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  let maxPrice = null;
  if (budget && entry) ({ maxTokens, maxPrice } = budget.plan({ entry, system, user, stage }));
  else if (entry && entry.in_usd_per_m != null) {
    maxPrice = { prompt: entry.in_usd_per_m, completion: entry.out_usd_per_m };
  }

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Title": "pr-critic",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        // Documented as deprecated and always on; sent anyway because it is harmless and
        // an older gateway would otherwise leave usage.cost out.
        usage: { include: true },
        // USD per million tokens, OpenRouter's unit for max_price. No provider charging
        // more than the rate the budget was sized with may serve the call.
        ...(maxPrice ? { provider: { max_price: maxPrice } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e) {
    // Sent, maybe served and billed, but no usage came back: charge the reservation.
    if (budget && entry) budget.debitReserved({ entry, system, user, maxTokens, stage, error: e });
    throw transportError("openrouter", e.name === "TimeoutError" ? "timeout" : "network", `OpenRouter ${model}: ${e.message}`);
  }

  if (!res.ok) {
    const body = redact((await res.text()).slice(0, 400));
    const err = new Error(`OpenRouter ${res.status}: ${body}`);
    err.transport = "openrouter";
    // Out of credit or a dead key is not a transient hiccup: it means no review
    // will ever run again until someone acts. Tagged so the caller can be loud
    // about it instead of passing green with a warning nobody reads.
    if (res.status === 401 || res.status === 402) err.fatal = true;
    // A 403 is usually about this model (moderation, a provider's region), so the
    // chain moves on; runChain makes it fatal on the last link, where a dead key ends.
    else if (res.status === 403) err.code = "forbidden";
    throw err;
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    // A 200 whose body broke mid-read was served and billed.
    if (budget && entry) budget.debitReserved({ entry, system, user, maxTokens, stage });
    throw transportError("openrouter", "network", `OpenRouter ${model}: unreadable response body: ${e.message}`);
  }
  const choice = body.choices?.[0];
  const text = choice?.message?.content;
  const usage = body.usage ?? {};
  const { cost, estimated } = costOf(usage, entry, {
    input: estimateInputTokens(system, user),
    output: estimateInputTokens(text ?? ""),
  });
  if (budget) budget.debit(stage, cost, estimated);
  if (!text) throw emptyAnswer(model, choice?.finish_reason === "length", choice?.finish_reason, maxTokens);
  return { text, usage, cost, estimated, model: body.model ?? model, paid_by: "openrouter" };
}
