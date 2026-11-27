import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeOpenAI } from "../src/openai.mjs";
import { completeAnthropic } from "../src/anthropic.mjs";
import { complete } from "../src/llm.mjs";
import { resolveModel } from "../src/models.mjs";
import { Budget } from "../src/cost.mjs";
import { REFUTE_SCHEMA } from "../src/refute.mjs";
import { main, runChain } from "../bin/pr-critic.mjs";
import { tempRepo, repoWith, fakeFetch, orReply, oaReply, anReply, apiError, finding, withEnv } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const sol = resolveModel("openai:gpt-6.1-sol", "critic");
const haiku = resolveModel("anthropic:claude-haiku-5.5", "refuter");
const OA = { OPENAI_API_KEY: "sk-test-openai" };
const AN = { ANTHROPIC_API_KEY: "sk-ant-test" };
const CRITIC_JSON = JSON.stringify({ findings: [finding()] });
const VERDICT_JSON = JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] });

const oa = (extra = {}) => completeOpenAI({ model: sol.id, entry: sol, system: "S", user: "U", ...extra });
const an = (extra = {}) =>
  completeAnthropic({ model: haiku.id, entry: haiku, system: "S", user: "U", schema: REFUTE_SCHEMA, ...extra });

// ---------- openai: ----------

test("openai: success sends the API model with JSON mode and max_completion_tokens, costed from the registry", async () => {
  const calls = fakeFetch({ answers: { "gpt-6.1-sol": [oaReply(CRITIC_JSON)] } });
  const budget = new Budget(0.5);
  const { result } = await withEnv(OA, () => oa({ budget, stage: "critic" }));
  assert.equal(result.text, CRITIC_JSON);
  assert.equal(result.model, "openai:gpt-6.1-sol");
  assert.equal(result.paid_by, "openai-credit");
  // 1000 prompt tokens at $2/M plus 100 completion tokens at $10/M.
  assert.ok(Math.abs(result.cost - 0.003) < 1e-12);
  assert.ok(Math.abs(budget.by.critic - 0.003) < 1e-12);

  const c = calls[0];
  assert.equal(c.kind, "openai");
  assert.equal(c.body.model, "gpt-6.1-sol");
  assert.deepEqual(c.body.response_format, { type: "json_object" });
  assert.equal(c.body.max_completion_tokens, 32_000);
  assert.equal(c.body.max_tokens, undefined);
  assert.equal(c.body.provider, undefined, "OpenAI has no max_price");
  assert.equal(c.body.temperature, undefined);
  assert.equal(c.headers.Authorization, "Bearer sk-test-openai");
});

test("openai: max_completion_tokens is bounded by what is left of the budget", async () => {
  const calls = fakeFetch({ answers: { "gpt-6.1-sol": [oaReply(CRITIC_JSON)] } });
  const budget = new Budget(0.5);
  budget.debit("critic", 0.4, false);
  await withEnv(OA, () => oa({ budget, stage: "fallback" }));
  // $0.10 left, less the one-token prompt reserved at $2/M, at $10/M output is 9999 tokens.
  assert.equal(calls[0].body.max_completion_tokens, 9_999);
});

for (const [name, status, body] of [
  ["insufficient_quota", 429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }],
  ["credit_balance_exhausted", 429, { error: { message: "Credit balance exhausted", type: "insufficient_quota", code: "credit_balance_exhausted" } }],
  ["project_spend_limit_exceeded", 429, { error: { message: "Project spend limit reached", code: "project_spend_limit_exceeded" } }],
]) {
  test(`openai: 429 ${name} is credit_exhausted and fails over, never fatal`, async () => {
    fakeFetch({ answers: { "gpt-6.1-sol": [apiError(status, body)] } });
    await withEnv(OA, () =>
      assert.rejects(oa(), (e) => e.code === "credit_exhausted" && e.transport === "openai" && !e.fatal),
    );
  });
}

test("openai: a plain rate limit is rate_limit, a 401 is auth, neither fatal", async () => {
  fakeFetch({
    answers: {
      "gpt-6.1-sol": [
        apiError(429, { error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } }),
        apiError(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }),
      ],
    },
  });
  await withEnv(OA, async () => {
    await assert.rejects(oa(), (e) => e.code === "rate_limit" && !e.fatal);
    await assert.rejects(oa(), (e) => e.code === "auth" && !e.fatal && !/sk-test-openai/.test(e.message));
  });
});

test("openai: empty content with finish_reason length is the whole-budget error, and is still debited", async () => {
  fakeFetch({ answers: { "gpt-6.1-sol": [oaReply("", { finish: "length", usage: { prompt_tokens: 1000, completion_tokens: 32000 } })] } });
  const budget = new Budget(0.5);
  await withEnv(OA, () =>
    assert.rejects(oa({ budget, stage: "critic" }), (e) => e.code === "empty" && /whole 32000-token budget/.test(e.message)),
  );
  assert.ok(budget.by.critic > 0.3);
});

test("complete() routes an openai: ID to api.openai.com", async () => {
  const calls = fakeFetch({ answers: { "gpt-6.1-sol": [oaReply(CRITIC_JSON)] } });
  await withEnv(OA, () => complete({ model: sol.id, entry: sol, system: "s", user: "u" }));
  assert.equal(calls[0].kind, "openai");
});

// ---------- anthropic: ----------

test("anthropic: success sends x-api-key, the API version, the API model and a JSON schema", async () => {
  const calls = fakeFetch({ answers: { "claude-haiku-5-5": [anReply(VERDICT_JSON)] } });
  const budget = new Budget(0.5);
  const { result } = await withEnv(AN, () => an({ budget, stage: "refuter" }));
  assert.equal(result.text, VERDICT_JSON, "the text block is read, the thinking block skipped");
  assert.equal(result.model, "anthropic:claude-haiku-5.5");
  assert.equal(result.paid_by, "anthropic-credit");
  // 1000 input tokens at $0.10/M plus 100 output tokens at $0.50/M.
  assert.ok(Math.abs(result.cost - 0.00015) < 1e-12);
  assert.ok(Math.abs(budget.by.refuter - 0.00015) < 1e-12);

  const c = calls[0];
  assert.equal(c.kind, "anthropic");
  assert.equal(c.headers["x-api-key"], "sk-ant-test");
  assert.equal(c.headers["anthropic-version"], "2026-10-21");
  assert.equal(c.body.model, "claude-haiku-5-5");
  assert.equal(c.body.system, "S");
  assert.deepEqual(c.body.messages, [{ role: "user", content: "U" }]);
  assert.equal(c.body.max_tokens, 32_000);
  assert.equal(c.body.output_config.format.type, "json_schema");
  assert.deepEqual(c.body.output_config.format.schema, REFUTE_SCHEMA);
  assert.equal(c.body.temperature, undefined);
});

for (const [name, status, body] of [
  ["400 credit balance too low", 400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }],
  ["402 billing_error", 402, { type: "error", error: { type: "billing_error", message: "billing issue" } }],
  ["429 spend cap", 429, { type: "error", error: { type: "rate_limit_error", message: "You have reached your API usage limits", details: { error_code: "enforced_spend_limit_reached" } } }],
]) {
  test(`anthropic: ${name} is credit_exhausted and fails over, never fatal`, async () => {
    fakeFetch({ answers: { "claude-haiku-5-5": [apiError(status, body)] } });
    await withEnv(AN, () =>
      assert.rejects(an(), (e) => e.code === "credit_exhausted" && e.transport === "anthropic" && !e.fatal),
    );
  });
}

test("anthropic: 429 is rate_limit, 529 overloaded, 401 auth; none fatal", async () => {
  fakeFetch({
    answers: {
      "claude-haiku-5-5": [
        apiError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
        apiError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
        apiError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
      ],
    },
  });
  await withEnv(AN, async () => {
    await assert.rejects(an(), (e) => e.code === "rate_limit" && !e.fatal);
    await assert.rejects(an(), (e) => e.code === "overloaded" && !e.fatal);
    await assert.rejects(an(), (e) => e.code === "auth" && !e.fatal && !/sk-ant-test/.test(e.message));
  });
});

test("anthropic: no text block with stop_reason max_tokens is the whole-budget error, and is still debited", async () => {
  fakeFetch({
    answers: { "claude-haiku-5-5": [anReply(null, { stop: "max_tokens", usage: { input_tokens: 1000, output_tokens: 32000 } })] },
  });
  const budget = new Budget(0.5);
  await withEnv(AN, () =>
    assert.rejects(an({ budget, stage: "refuter" }), (e) => e.code === "empty" && /whole 32000-token budget/.test(e.message)),
  );
  assert.ok(budget.by.refuter > 0.015);
});

// ---------- the chain, through the CLI ----------

// A function: a Response body can be read once, so each test needs its own.
const refuterOk = () => ({ "anthropic/claude-haiku-5.5": [orReply(VERDICT_JSON)] });

test("cli: an exhausted OpenAI credit fails over to the OpenRouter critic and meta.chain says why", async () => {
  const cwd = tempRepo();
  const calls = fakeFetch({
    answers: {
      "gpt-6.1-sol": [apiError(429, { error: { message: "Credit balance exhausted", code: "credit_balance_exhausted" } })],
      "x-ai/grok-4.3": [orReply(CRITIC_JSON)],
      ...refuterOk(),
    },
  });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k", ...OA }, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  const meta = result.result.meta;
  assert.equal(meta.chain.critic[0], "openai:gpt-6.1-sol");
  assert.equal(meta.chain.attempts[0].error, "credit_exhausted");
  assert.equal(meta.critic, "x-ai/grok-4.3");
  assert.deepEqual(meta.warnings ?? [], []);
  assert.deepEqual(calls.filter((c) => c.kind !== "github").map((c) => c.kind), ["openai", "openrouter", "openrouter"]);
});

test("cli: a rejected OpenAI key fails over with a ::warning:: and a footer line on the review", async () => {
  const cwd = tempRepo();
  let review;
  fakeFetch({
    answers: {
      "gpt-6.1-sol": [apiError(401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } })],
      "x-ai/grok-4.3": [orReply(CRITIC_JSON)],
      ...refuterOk(),
    },
    github: {
      "POST /repos/o/r/pulls/7/reviews": (u, init) => {
        review = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      },
      "GET /repos/o/r/pulls/7/reviews": () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }),
    },
  });
  const { result, stdout, stderr } = await withEnv(
    { OPENROUTER_API_KEY: "k", ...OA, GITHUB_TOKEN: "t", GITHUB_ACTIONS: "true" },
    () => main({ argv: ["--base", "HEAD~1", "--post", "--pr", "7", "--repo", "o/r"], cwd }),
  );
  assert.equal(result.code, 0);
  const meta = result.result.meta;
  assert.equal(meta.chain.attempts[0].error, "auth");
  assert.deepEqual(meta.warnings, ["OpenAI credit key rejected, fell back to x-ai/grok-4.3"]);
  assert.ok(stdout.some((l) => l.startsWith("::warning::openai credit key rejected")), stdout.join("\n"));
  assert.match(review.body, /OpenAI credit key rejected, fell back to x-ai\/grok-4\.3/);
  assert.doesNotMatch([...stdout, ...stderr].join("\n"), /sk-test-openai/);
});

test("cli: outside Actions the warning goes to stderr, keeping stdout JSON", async () => {
  const cwd = tempRepo();
  fakeFetch({
    answers: {
      "gpt-6.1-sol": [apiError(403, { error: { message: "Country, region, or territory not supported" } })],
      "x-ai/grok-4.3": [orReply(CRITIC_JSON)],
      ...refuterOk(),
    },
  });
  const { stdout, stderr } = await withEnv({ OPENROUTER_API_KEY: "k", ...OA }, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.ok(stderr.some((l) => l.startsWith("::warning::openai credit key rejected")));
  assert.doesNotThrow(() => JSON.parse(stdout.join("\n")));
});

test("cli: a rejected Anthropic key fails over to the same model on OpenRouter, with the footer line", async () => {
  const cwd = tempRepo();
  fakeFetch({
    answers: {
      "x-ai/grok-4.3": [orReply(CRITIC_JSON)],
      "claude-haiku-5-5": [apiError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })],
      ...refuterOk(),
    },
  });
  const { result, stderr } = await withEnv({ OPENROUTER_API_KEY: "k", ...AN }, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  const meta = result.result.meta;
  assert.equal(meta.chain.refuter[0], "anthropic:claude-haiku-5.5");
  assert.equal(meta.refuter, "anthropic/claude-haiku-5.5");
  assert.deepEqual(meta.warnings, ["Anthropic credit key rejected, fell back to anthropic/claude-haiku-5.5"]);
  assert.ok(stderr.some((l) => l.startsWith("::warning::anthropic credit key rejected")));
});

test("cli: an Anthropic credit refuter is used first and labelled as paid from credit", async () => {
  const cwd = tempRepo();
  const calls = fakeFetch({
    answers: { "x-ai/grok-4.3": [orReply(CRITIC_JSON)], "claude-haiku-5-5": [anReply(VERDICT_JSON)] },
  });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k", ...AN }, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  assert.equal(result.result.meta.refuter, "anthropic:claude-haiku-5.5");
  assert.equal(result.result.meta.cost.paid_by.refuter, "anthropic-credit");
  assert.equal(result.result.findings.length, 1);
  assert.ok(!calls.some((c) => c.model === "anthropic/claude-haiku-5.5"));
});

test("cli: exhausted Anthropic credit fails over to OpenRouter", async () => {
  const cwd = tempRepo();
  fakeFetch({
    answers: {
      "x-ai/grok-4.3": [orReply(CRITIC_JSON)],
      "claude-haiku-5-5": [apiError(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })],
      ...refuterOk(),
    },
  });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k", ...AN }, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  const refuterAttempts = result.result.meta.chain.attempts.filter((a) => a.role === "refuter");
  assert.equal(refuterAttempts[0].error, "credit_exhausted");
  assert.equal(result.result.meta.refuter, "anthropic/claude-haiku-5.5");
});

test("cli: a refuter shape failure on every link, anthropic: included, still posts the no-review notice", async () => {
  const cwd = tempRepo();
  const bad = JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIMRED", reason: "r" }] });
  const calls = fakeFetch({
    answers: {
      "x-ai/grok-4.3": [orReply(CRITIC_JSON)],
      "claude-haiku-5-5": [anReply(bad)],
      "anthropic/claude-haiku-5.5": [orReply(bad)],
      "google/gemini-3.1-pro-preview": [orReply(bad)],
    },
    github: { "POST /repos/o/r/issues/7/comments": () => new Response(JSON.stringify({ id: 55 }), { status: 201 }) },
  });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k", ...AN, GITHUB_TOKEN: "t" }, () =>
    main({ argv: ["--base", "HEAD~1", "--post", "--pr", "7", "--repo", "o/r"], cwd }),
  );
  assert.equal(result.code, 1);
  const posts = calls.filter((c) => c.kind === "github" && c.method === "POST");
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.body, /refuter step failed after calling `anthropic:claude-haiku-5.5`, then `anthropic\/claude-haiku-5.5`, then `google\/gemini-3.1-pro-preview`/);
});

test("a rejected credit key on the last link of a chain is fatal", async () => {
  const link = { id: "openai:gpt-6.1-sol", family: "openai", transport: "openai" };
  const attempts = [];
  const auth = Object.assign(new Error("OpenAI 401"), { code: "auth", transport: "openai" });
  await withEnv({}, () =>
    assert.rejects(
      runChain({ links: [link], role: "critic", attempts, warnings: [], call: async () => { throw auth; } }),
      (e) => e.fatal === true,
    ),
  );
});

// ---------- review fixes, round 1 ----------

test("cli: a GitHub 500 on the review POST keeps the survivors in --json, posts the notice naming the artifact, exits 1", async () => {
  const cwd = tempRepo();
  const json = join(mkdtempSync(join(tmpdir(), "pr-critic-json-")), "out.json");
  const calls = fakeFetch({
    answers: { "x-ai/grok-4.3": [orReply(CRITIC_JSON)], "anthropic/claude-haiku-5.5": [orReply(VERDICT_JSON)] },
    github: {
      "POST /repos/o/r/pulls/7/reviews": () => new Response("server error", { status: 500 }),
      "POST /repos/o/r/issues/7/comments": () => new Response(JSON.stringify({ id: 55 }), { status: 201 }),
    },
  });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k", GITHUB_TOKEN: "t" }, () =>
    main({ argv: ["--base", "HEAD~1", "--post", "--pr", "7", "--repo", "o/r", "--json", json], cwd }),
  );
  assert.equal(result.code, 1);
  const out = JSON.parse(readFileSync(json, "utf8"));
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].claim, "division by zero");
  const notice = calls.find((c) => c.kind === "github" && c.method === "POST" && c.path === "/repos/o/r/issues/7/comments");
  assert.ok(notice, "the no-review notice was posted");
  assert.match(notice.body.body, /post step failed/);
  assert.match(notice.body.body, /500/);
  assert.match(notice.body.body, /artifact/);
  assert.match(notice.body.body, /`pr-critic-7`/);
});

test("cli: --max-cost 0.1 with a big prompt: openai: trips the cap and x-ai/grok-4.3 runs", async () => {
  // About 40k tokens: past what openai: can fit under $0.10 at $2/M in and $10/M out
  // with the 4000-token floor, inside what grok can at $1.25/M and $2.50/M.
  const big = Array.from({ length: 4000 }, (_, i) => `export const v${i} = "${"y".repeat(28)}";`).join("\n") + "\n";
  const cwd = repoWith({}, { "big.js": big });
  const calls = fakeFetch({
    answers: {
      "gpt-6.1-sol": [oaReply(CRITIC_JSON)],
      "x-ai/grok-4.3": [orReply(JSON.stringify({ findings: [finding({ file: "big.js", line: 2 })] }), { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 })],
      ...refuterOk(),
    },
  });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k", ...OA }, () =>
    main({ argv: ["--base", "HEAD~1", "--max-cost", "0.1"], cwd }),
  );
  assert.equal(result.code, 0);
  const attempts = result.result.meta.chain.attempts;
  assert.equal(attempts[0].model, "openai:gpt-6.1-sol");
  assert.equal(attempts[0].error, "cost_cap");
  assert.equal(result.result.meta.critic, "x-ai/grok-4.3");
  assert.ok(!calls.some((c) => c.kind === "openai"), "openai: was skipped before any request");
});

for (const [name, key] of [
  ["openai:", OA],
  ["anthropic:", AN],
  ["OpenRouter", { OPENROUTER_API_KEY: "k" }],
]) {
  test(`${name} a fetch that rejects after the request is sent debits the reserved worst case`, async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const budget = new Budget(0.5);
    const entry = name === "anthropic:" ? haiku : name === "openai:" ? sol : resolveModel("openai/gpt-6.1-sol", "critic");
    const run = name === "openai:" ? oa : name === "anthropic:" ? an : (x) => complete({ model: entry.id, entry, system: "S", user: "U", ...x });
    // One input token for "S"+"U"; max_tokens is the 32k ceiling at this budget.
    const reserved = (1 * entry.in_usd_per_m + 32_000 * entry.out_usd_per_m) / 1e6;
    await withEnv(key, () => assert.rejects(run({ budget, stage: "critic" })));
    assert.ok(Math.abs(budget.spent - reserved) < 1e-12, `spent ${budget.spent}, reserved ${reserved}`);
    assert.equal(budget.estimated, true);
  });

  test(`${name} a connection that never reached the server debits nothing`, async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]) {
      globalThis.fetch = async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
      };
      const budget = new Budget(0.5);
      const entry = name === "anthropic:" ? haiku : name === "openai:" ? sol : resolveModel("openai/gpt-6.1-sol", "critic");
      const run = name === "openai:" ? oa : name === "anthropic:" ? an : (x) => complete({ model: entry.id, entry, system: "S", user: "U", ...x });
      await withEnv(key, () => assert.rejects(run({ budget, stage: "critic" })));
      assert.equal(budget.spent, 0, code);
    }
  });

  test(`${name} a body that fails to read after a 200 debits the reserved worst case`, async () => {
    globalThis.fetch = async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
    const budget = new Budget(0.5);
    const entry = name === "anthropic:" ? haiku : name === "openai:" ? sol : resolveModel("openai/gpt-6.1-sol", "critic");
    const run = name === "openai:" ? oa : name === "anthropic:" ? an : (x) => complete({ model: entry.id, entry, system: "S", user: "U", ...x });
    await withEnv(key, () => assert.rejects(run({ budget, stage: "critic" })));
    assert.ok(budget.spent > 0, `spent ${budget.spent}`);
  });
}

test("OpenRouter 403 on grok fails over to openai/gpt-6.1-sol", async () => {
  const cwd = tempRepo();
  fakeFetch({
    answers: {
      "x-ai/grok-4.3": [apiError(403, { error: { message: "flagged by moderation" } })],
      "openai/gpt-6.1-sol": [orReply(CRITIC_JSON)],
      ...refuterOk(),
    },
  });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k" }, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  assert.equal(result.result.meta.critic, "openai/gpt-6.1-sol");
  assert.equal(result.result.meta.chain.attempts[0].model, "x-ai/grok-4.3");
});

test("OpenRouter 403 on the last link of a chain is still fatal", async () => {
  const link = { id: "x-ai/grok-4.3", family: "x-ai", transport: "openrouter" };
  fakeFetch({ answers: { "x-ai/grok-4.3": [apiError(403, { error: { message: "Forbidden" } })] } });
  await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
    assert.rejects(
      runChain({ links: [link], role: "critic", attempts: [], call: () => complete({ model: link.id, system: "s", user: "u" }) }),
      (e) => e.fatal === true,
    ),
  );
});

test("an OpenRouter error body is redacted before it reaches the error message", async () => {
  const secret = "sk-or-v1-" + "a1".repeat(32);
  fakeFetch({ answers: { "x-ai/grok-4.3": [new Response(`upstream echoed Bearer ${secret}`, { status: 500 })] } });
  await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
    assert.rejects(complete({ model: "x-ai/grok-4.3", system: "s", user: "u" }), (e) => {
      assert.doesNotMatch(e.message, /a1a1a1a1/);
      assert.match(e.message, /\[redacted\]/);
      return true;
    }),
  );
});
