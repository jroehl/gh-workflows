import { complete, parseJson } from "./openrouter.mjs";

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

export async function runRefute({ model, context, findings }) {
  if (findings.length === 0) return { verdicts: [], usage: {}, model };

  const list = findings
    .map(
      (f, i) =>
        `[${i}] ${f.file}:${f.line ?? "?"} (${f.severity}) ${f.claim}\n    failure: ${f.failure_scenario}`,
    )
    .join("\n");

  const user = `## Findings to refute\n${list}\n\n## Diff\n${context.diff}`;
  const { text, usage, model: used } = await complete({ model, system: SYSTEM, user });
  const parsed = parseJson(text);
  return { verdicts: Array.isArray(parsed.verdicts) ? parsed.verdicts : [], usage, model: used };
}
