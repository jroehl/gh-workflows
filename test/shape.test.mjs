import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runCritic } from "../src/critic.mjs";
import { runRefute } from "../src/refute.mjs";
import { main } from "../bin/pr-critic.mjs";
import { tempRepo, fakeFetch, orReply, finding, withEnv } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const context = { diff: "diff --git a/a.js b/a.js\n", stat: "a.js | 1", truncated: false };
const KEY = { OPENROUTER_API_KEY: "k" };

async function criticSays(content) {
  fakeFetch({ answers: { "x-ai/grok-4.3": [orReply(content)] } });
  return withEnv(KEY, () => runCritic({ model: "x-ai/grok-4.3", context, intent: "x" }));
}

async function refuterSays(content, n = 2) {
  fakeFetch({ answers: { "google/gemini-3.1-pro-preview": [orReply(content)] } });
  const findings = Array.from({ length: n }, () => finding());
  return withEnv(KEY, () => runRefute({ model: "google/gemini-3.1-pro-preview", context, findings }));
}

test("critic: {} is a shape failure, not a clean review", async () => {
  await assert.rejects(criticSays("{}"), (e) => e.code === "shape" && !e.fatal);
});

test('critic: {"findings": "x"} is a shape failure', async () => {
  await assert.rejects(criticSays('{"findings":"x"}'), (e) => e.code === "shape");
});

test("critic: a finding without failure_scenario or with a bad severity fails the link", async () => {
  const noScenario = { ...finding() };
  delete noScenario.failure_scenario;
  await assert.rejects(criticSays(JSON.stringify({ findings: [noScenario] })), /failure_scenario/);
  await assert.rejects(
    criticSays(JSON.stringify({ findings: [finding({ severity: "urgent" })] })),
    /severity/,
  );
});

test("critic: an empty findings array is a valid clean answer", async () => {
  const { result } = await criticSays('{"findings":[]}');
  assert.deepEqual(result.findings, []);
});

test("refuter: a CONFIMRED typo fails the refuter", async () => {
  const v = { verdicts: [{ index: 0, verdict: "CONFIMRED", reason: "r" }, { index: 1, verdict: "REFUTED", reason: "r" }] };
  await assert.rejects(refuterSays(JSON.stringify(v)), (e) => e.code === "shape" && /CONFIMRED/.test(e.message));
});

test("refuter: a missing index fails the refuter", async () => {
  const v = { verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] };
  await assert.rejects(refuterSays(JSON.stringify(v)), (e) => e.code === "shape" && /index 1/.test(e.message));
});

test("refuter: a duplicate index fails the refuter", async () => {
  const v = {
    verdicts: [
      { index: 0, verdict: "CONFIRMED", reason: "r" },
      { index: 0, verdict: "REFUTED", reason: "r" },
      { index: 1, verdict: "REFUTED", reason: "r" },
    ],
  };
  await assert.rejects(refuterSays(JSON.stringify(v)), (e) => e.code === "shape" && /duplicate/.test(e.message));
});

test("refuter: an out-of-range index fails the refuter", async () => {
  const v = {
    verdicts: [
      { index: 0, verdict: "CONFIRMED", reason: "r" },
      { index: 1, verdict: "REFUTED", reason: "r" },
      { index: 2, verdict: "REFUTED", reason: "r" },
    ],
  };
  await assert.rejects(refuterSays(JSON.stringify(v)), (e) => e.code === "shape");
});

test("refuter: one valid verdict per index passes", async () => {
  const v = { verdicts: [{ index: 1, verdict: "REFUTED", reason: "r" }, { index: 0, verdict: "UNPROVEN", reason: "r" }] };
  const { result } = await refuterSays(JSON.stringify(v));
  assert.equal(result.verdicts.length, 2);
});

test("cli: {} from the critic triggers the fallback, and the reason lands in meta.chain", async () => {
  const cwd = tempRepo();
  const calls = fakeFetch({
    answers: {
      "x-ai/grok-4.3": [orReply("{}")],
      "openai/gpt-6.1-sol": [orReply(JSON.stringify({ findings: [finding()] }))],
      "anthropic/claude-haiku-5.5": [
        orReply(JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] })),
      ],
    },
  });
  const { result } = await withEnv(KEY, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  assert.deepEqual(
    calls.filter((c) => c.kind === "openrouter").map((c) => c.model),
    ["x-ai/grok-4.3", "openai/gpt-6.1-sol", "anthropic/claude-haiku-5.5"],
  );
  assert.equal(result.result.meta.critic, "openai/gpt-6.1-sol");
  assert.equal(result.result.findings.length, 1);
  const failed = result.result.meta.chain.attempts.find((a) => a.model === "x-ai/grok-4.3");
  assert.equal(failed.error, "shape");
});

test("cli: a refuter shape failure posts the no-review notice instead of an empty review", async () => {
  const cwd = tempRepo();
  const calls = fakeFetch({
    answers: {
      "x-ai/grok-4.3": [orReply(JSON.stringify({ findings: [finding(), finding({ line: 1 })] }))],
      "anthropic/claude-haiku-5.5": [
        orReply(JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] })),
      ],
      "google/gemini-3.1-pro-preview": [
        orReply(JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] })),
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
  const posts = calls.filter((c) => c.kind === "github" && c.method === "POST");
  assert.equal(posts.length, 1, "only the notice is posted, never a review");
  assert.match(posts[0].path, /issues\/7\/comments/);
  assert.match(posts[0].body.body, /refuter step failed/);
  assert.match(posts[0].body.body, /index 1/);
});
