import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Budget, costOf } from "../src/cost.mjs";
import { resolveModel } from "../src/models.mjs";
import { complete } from "../src/llm.mjs";
import { main } from "../bin/pr-critic.mjs";
import { tempRepo, fakeFetch, orReply, finding, withEnv } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY = { OPENROUTER_API_KEY: "k" };
const gemini = resolveModel("google/gemini-3.1-pro-preview", "refuter");
const grok = resolveModel("x-ai/grok-4.3", "critic");

test("a $0.49 critic and a refuter estimated at $0.20 stop before the refuter under a $0.50 cap", () => {
  const budget = new Budget(0.5);
  budget.debit("critic", 0.49, false);
  // 400k characters is 100k tokens, $0.20 at Gemini's $2/M input rate.
  const user = "x".repeat(400_000);
  assert.throws(
    () => budget.plan({ entry: gemini, system: "", user, stage: "refuter" }),
    (e) => e.code === "cost_cap" && /cost cap \$0\.50 reached after critic/.test(e.message),
  );
});

test("the input reservation alone can trip the cap", () => {
  const budget = new Budget(0.5);
  budget.debit("critic", 0.3, false);
  assert.throws(
    () => budget.plan({ entry: gemini, system: "", user: "x".repeat(400_000), stage: "refuter" }),
    (e) => e.code === "cost_cap",
  );
});

test("max_tokens is bounded by what remains at the output rate", () => {
  const budget = new Budget(0.5);
  budget.debit("critic", 0.4, false);
  const plan = budget.plan({ entry: gemini, system: "", user: "", stage: "refuter" });
  // $0.10 left at $12/M output is 8333 tokens.
  assert.equal(plan.maxTokens, 8333);
  assert.deepEqual(plan.maxPrice, { prompt: 2, completion: 12 });
});

test("max_tokens never exceeds the 32k ceiling, and below the 4000 floor the call is skipped", () => {
  assert.equal(new Budget(0.5).plan({ entry: grok, system: "", user: "", stage: "critic" }).maxTokens, 32_000);
  const budget = new Budget(0.5);
  budget.debit("critic", 0.46, false);
  // $0.04 at $12/M is 3333 tokens, under the floor.
  assert.throws(() => budget.plan({ entry: gemini, system: "", user: "", stage: "refuter" }), /cost cap/);
});

test("a missing usage.cost is estimated from registry prices", () => {
  const c = costOf({ prompt_tokens: 1_000_000, completion_tokens: 100_000 }, gemini);
  assert.equal(c.estimated, true);
  assert.ok(Math.abs(c.cost - (2 + 1.2)) < 1e-9);
  const reported = costOf({ prompt_tokens: 1, completion_tokens: 1, cost: 0.123 }, gemini);
  assert.deepEqual(reported, { cost: 0.123, estimated: false });
});

test("complete sends usage.include and provider.max_price, and debits before the answer is parsed", async () => {
  const calls = fakeFetch({
    answers: { "google/gemini-3.1-pro-preview": [orReply("not json at all", { prompt_tokens: 10, completion_tokens: 10, cost: 0.07 })] },
  });
  const budget = new Budget(0.5);
  const { result } = await withEnv(KEY, () =>
    complete({ model: gemini.id, system: "s", user: "u", entry: gemini, budget, stage: "refuter" }),
  );
  assert.equal(result.text, "not json at all");
  assert.equal(budget.by.refuter, 0.07);
  const body = calls[0].body;
  assert.deepEqual(body.usage, { include: true });
  assert.deepEqual(body.provider, { max_price: { prompt: 2, completion: 12 } });
});

test("an empty answer that was billed still counts toward the cap", async () => {
  fakeFetch({
    answers: {
      "x-ai/grok-4.3": [
        new Response(
          JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { cost: 0.2 } }),
          { status: 200 },
        ),
      ],
    },
  });
  const budget = new Budget(0.5);
  await withEnv(KEY, () =>
    assert.rejects(complete({ model: grok.id, system: "", user: "", entry: grok, budget, stage: "critic" })),
  );
  assert.equal(budget.by.critic, 0.2);
});

test("cli: a $0.49 critic stops before the refuter, posts the cost-cap notice, exits 1", async () => {
  const cwd = tempRepo();
  const calls = fakeFetch({
    answers: {
      "x-ai/grok-4.3": [
        orReply(JSON.stringify({ findings: [finding()] }), { prompt_tokens: 1, completion_tokens: 1, cost: 0.49 }),
      ],
    },
    github: {
      "POST /repos/o/r/issues/7/comments": () => new Response(JSON.stringify({ id: 55 }), { status: 201 }),
    },
  });
  const { result } = await withEnv({ ...KEY, GITHUB_TOKEN: "t" }, () =>
    main({ argv: ["--base", "HEAD~1", "--post", "--pr", "7", "--repo", "o/r"], cwd }),
  );
  assert.equal(result.code, 1);
  assert.ok(!calls.some((c) => c.model === "google/gemini-3.1-pro-preview"), "the refuter was never called");
  const notice = calls.find((c) => c.kind === "github" && c.method === "POST");
  assert.match(notice.body.body, /cost cap \$0\.50 reached after critic/);
});

test("cli: meta.cost splits critic, fallback and refuter and marks estimates", async () => {
  const cwd = tempRepo();
  fakeFetch({
    answers: {
      "x-ai/grok-4.3": [orReply("{}", { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 })],
      "openai/gpt-6.1-sol": [orReply(JSON.stringify({ findings: [finding()] }), { prompt_tokens: 1000, completion_tokens: 100 })],
      "google/gemini-3.1-pro-preview": [
        orReply(JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] }), {
          prompt_tokens: 1,
          completion_tokens: 1,
          cost: 0.02,
        }),
      ],
    },
  });
  const { result } = await withEnv(KEY, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  const cost = result.result.meta.cost;
  assert.equal(cost.critic, 0.01);
  assert.ok(Math.abs(cost.fallback - (1000 * 2 + 100 * 10) / 1e6) < 1e-12);
  assert.equal(cost.refuter, 0.02);
  assert.ok(Math.abs(cost.total - (0.01 + 0.003 + 0.02)) < 1e-12);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.estimated, true);
});

test("cli: --max-cost must be a positive number", async () => {
  const cwd = tempRepo();
  fakeFetch();
  const { result } = await withEnv(KEY, () => main({ argv: ["--base", "HEAD~1", "--max-cost", "abc"], cwd }));
  assert.equal(result.code, 3);
});
