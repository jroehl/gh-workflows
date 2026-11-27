import { complete, parseJson } from "./llm.mjs";

// The answer shape below as a JSON schema, for the transports that can hold a model to
// one (codex --output-schema, Anthropic structured outputs). Strict-mode rules apply:
// every property required, no extra properties, a nullable line spelled with anyOf.
export const CRITIC_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { anyOf: [{ type: "integer" }, { type: "null" }] },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          claim: { type: "string" },
          failure_scenario: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["file", "line", "severity", "claim", "failure_scenario", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

const SYSTEM = `You are a hostile code reviewer. You did not write this change and you have
no access to the author's reasoning: you see only the diff and the stated intent. That
asymmetry is deliberate. Assume the change is wrong until the diff proves otherwise.

Report a finding ONLY when you can describe a concrete way it fails: specific inputs, state
or sequence, and the wrong behaviour that results. "Could be unsafe", "consider adding" and
"might be better" are not findings. If you cannot name the failure, you have no finding.

Out of scope, never report: formatting, naming, import order, comment wording, test coverage
as an abstraction, or any defence against a case the code cannot reach. Do not propose new
layers, helpers or abstractions.

In scope: logic that produces a wrong result, unhandled error and edge cases that occur in
practice, race conditions, resource and connection leaks, security and authorisation holes,
data loss or corruption, breaking changes to existing callers, secrets exposed to an
untrusted context, and any check that reports success without proving it.

Return at most 12 findings, best first. Report nothing rather than pad the list.

Answer with JSON only:
{"findings":[{"file":"path","line":<int|null>,"severity":"critical|high|medium|low",
"claim":"one sentence","failure_scenario":"inputs or state -> wrong outcome",
"confidence":"high|medium|low"}]}`;

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

function shapeError(message) {
  const err = new Error(`critic answer has the wrong shape: ${message}`);
  err.code = "shape";
  return err;
}

// Valid JSON of the wrong shape used to become an empty findings list, which reads
// exactly like a clean review. A wrong shape is a failed attempt instead, so the next
// link in the chain runs.
export function validateCriticAnswer(parsed) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.findings)) {
    throw shapeError("no findings array");
  }
  parsed.findings.forEach((f, i) => {
    if (!f || typeof f !== "object") throw shapeError(`finding ${i} is not an object`);
    for (const key of ["file", "claim", "failure_scenario"]) {
      if (typeof f[key] !== "string" || f[key] === "") throw shapeError(`finding ${i} has no ${key} string`);
    }
    if (!SEVERITIES.has(f.severity)) throw shapeError(`finding ${i} has severity ${JSON.stringify(f.severity)}`);
  });
  return parsed.findings;
}

export async function runCritic({ model, context, intent, entry, budget, stage = "critic" }) {
  const user = [
    intent ? `## Stated intent\n${intent}` : "## Stated intent\n(none given)",
    `## Files changed\n${context.stat || "(none)"}`,
    context.truncated ? "\nNote: the diff was truncated per file; judge only what you see." : "",
    `## Diff\n${context.diff}`,
  ].join("\n\n");

  const { text, usage, cost, model: used, paid_by } = await complete({
    model,
    system: SYSTEM,
    user,
    schema: CRITIC_SCHEMA,
    entry,
    budget,
    stage,
  });
  const findings = validateCriticAnswer(parseJson(text));
  return { findings, usage, cost, model: used, paid_by };
}
