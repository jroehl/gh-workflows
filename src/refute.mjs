import { complete, parseJson } from "./llm.mjs";

// The answer shape as a JSON schema, for codex --output-schema and Anthropic structured
// outputs. It cannot say "one verdict per index"; validateRefuteAnswer does.
export const REFUTE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          verdict: { type: "string", enum: ["CONFIRMED", "REFUTED", "UNPROVEN"] },
          reason: { type: "string" },
        },
        required: ["index", "verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

// The refuter runs on a different model family from the critic on purpose: a model
// asked to check its own output tends to confirm it.
const SYSTEM = `You are refuting code-review findings. Your default verdict is REFUTED. For
each finding, try to prove it wrong using the diff: the case cannot occur, the guard already
exists elsewhere in the diff, the API does not behave as claimed, or the "failure" is a
style preference wearing a failure scenario as a disguise.

Uphold a finding ONLY if the described failure genuinely follows from the code shown. If the
finding depends on code you cannot see, verdict UNPROVEN, never CONFIRMED.

Answer with JSON only:
{"verdicts":[{"index":<int>,"verdict":"CONFIRMED|REFUTED|UNPROVEN","reason":"one sentence"}]}`;

const VERDICTS = new Set(["CONFIRMED", "REFUTED", "UNPROVEN"]);

function shapeError(message) {
  const err = new Error(`refuter answer has the wrong shape: ${message}`);
  err.code = "shape";
  return err;
}

// A missing or misspelled verdict used to turn into UNPROVEN and quietly drop the
// finding, so a malformed answer could clear a whole review. Exactly one valid verdict
// per finding, or the attempt failed.
export function validateRefuteAnswer(parsed, n) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.verdicts)) {
    throw shapeError("no verdicts array");
  }
  const seen = new Set();
  for (const v of parsed.verdicts) {
    if (!v || typeof v !== "object") throw shapeError("a verdict is not an object");
    if (!Number.isInteger(v.index) || v.index < 0 || v.index >= n) {
      throw shapeError(`index ${JSON.stringify(v.index)} is not one of 0..${n - 1}`);
    }
    if (seen.has(v.index)) throw shapeError(`duplicate verdict for index ${v.index}`);
    seen.add(v.index);
    if (!VERDICTS.has(v.verdict)) throw shapeError(`index ${v.index} has verdict ${JSON.stringify(v.verdict)}`);
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) throw shapeError(`no verdict for index ${i}`);
  return parsed.verdicts;
}

// `call` is the transport, swappable so the A/B harness can cache raw answers and
// replay them, or stand in a refuter that never touches the network.
export async function runRefute({ model, context, findings, entry, budget, stage = "refuter", call = complete }) {
  if (findings.length === 0) return { verdicts: [], usage: {}, cost: 0, model };

  const list = findings
    .map(
      (f, i) =>
        `[${i}] ${f.file}:${f.line ?? "?"} (${f.severity}) ${f.claim}\n    failure: ${f.failure_scenario}`,
    )
    .join("\n");

  const user = `## Findings to refute\n${list}\n\n## Diff\n${context.diff}`;
  const { text, usage, cost, model: used, paid_by } = await call({
    model,
    system: SYSTEM,
    user,
    schema: REFUTE_SCHEMA,
    entry,
    budget,
    stage,
  });
  const verdicts = validateRefuteAnswer(parseJson(text), findings.length);
  return { verdicts, usage, cost, model: used, paid_by };
}
