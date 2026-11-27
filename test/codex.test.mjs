import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { completeCodex } from "../src/codex.mjs";
import { complete } from "../src/llm.mjs";
import { resolveModel } from "../src/models.mjs";
import { Budget } from "../src/cost.mjs";
import { CRITIC_SCHEMA } from "../src/critic.mjs";
import { main } from "../bin/pr-critic.mjs";
import { tempRepo, fakeFetch, fakeCodex, orReply, finding, withEnv } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const codexSol = resolveModel("codex:gpt-6.1-sol", "critic");
const ANSWER = JSON.stringify({ findings: [finding()] });

// The local environment the codex: link runs in: CI unset, a fake codex first on PATH,
// and secrets that must not reach it.
function localEnv(codex, extra = {}) {
  return {
    CI: undefined,
    PATH: `${codex.dir}:${process.env.PATH}`,
    OPENROUTER_API_KEY: "or-secret",
    GITHUB_TOKEN: "gh-secret",
    OPENAI_API_KEY: undefined,
    SENTINEL_ENV: "sentinel-value",
    ...extra,
  };
}

const call = (extra = {}) =>
  completeCodex({ model: codexSol.id, entry: codexSol, system: "SYS", user: "USER", schema: CRITIC_SCHEMA, ...extra });

test("codex: a valid answer comes back with zero cost and the tokens from the --json events", async () => {
  const codex = fakeCodex({ answer: ANSWER });
  const budget = new Budget(0.5);
  const { result } = await withEnv(localEnv(codex), () => call({ budget, stage: "critic" }));
  assert.equal(result.text, ANSWER);
  assert.equal(result.model, "codex:gpt-6.1-sol");
  assert.equal(result.cost, 0);
  assert.equal(result.paid_by, "codex-subscription");
  assert.equal(result.usage.prompt_tokens, 1200);
  assert.equal(result.usage.completion_tokens, 300);
  assert.equal(budget.spent, 0);

  const log = codex.log();
  const argv = log.split("\n").find((l) => l.startsWith("ARGV exec"));
  for (const flag of [
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-s read-only",
    "--skip-git-repo-check",
    "-m gpt-6.1-sol",
    "--output-schema",
    "--json",
    "--disable shell_tool",
    "--disable unified_exec",
    "--disable view_image",
  ]) {
    assert.ok(argv.includes(flag), `codex was not given ${flag}: ${argv}`);
  }
  assert.match(log, /^CDLIST $/m, "the working directory codex is given is empty");
  assert.match(log, /STDIN SYS/);
  assert.match(log, /STDIN USER/);
});

test("codex: the scrubbed environment carries PATH, HOME and CODEX_HOME and no secret", async () => {
  const codex = fakeCodex({ answer: ANSWER });
  await withEnv(localEnv(codex), () => call());
  const env = codex
    .log()
    .split("\n")
    .filter((l) => l.startsWith("ENV "))
    .map((l) => l.slice(4).split("=")[0]);
  for (const secret of ["OPENROUTER_API_KEY", "GITHUB_TOKEN", "SENTINEL_ENV", "CI"]) {
    assert.ok(!env.includes(secret), `${secret} reached codex`);
  }
  for (const kept of ["PATH", "HOME", "CODEX_HOME"]) assert.ok(env.includes(kept), `${kept} missing`);
  assert.doesNotMatch(codex.log(), /or-secret|gh-secret|sentinel-value/);
});

test("codex: exit 1 is a codex_exit failure, never fatal", async () => {
  const codex = fakeCodex({ exit: 1, stderr: "something broke" });
  await withEnv(localEnv(codex), () =>
    assert.rejects(call(), (e) => e.code === "codex_exit" && e.transport === "codex" && !e.fatal && /something broke/.test(e.message)),
  );
});

test("codex: a usage-limit message is codex_quota, and a login problem codex_auth", async () => {
  const quota = fakeCodex({ exit: 1, stderr: "You've hit your usage limit. Try again in 3 hours." });
  await withEnv(localEnv(quota), () => assert.rejects(call(), (e) => e.code === "codex_quota" && !e.fatal));
  const auth = fakeCodex({ exit: 1, stderr: "Not logged in. Run codex login." });
  await withEnv(localEnv(auth), () => assert.rejects(call(), (e) => e.code === "codex_auth" && !e.fatal));
});

test("codex: a hang is killed at the timeout as codex_timeout", async () => {
  const codex = fakeCodex({ answer: ANSWER, sleep: 5 });
  const started = Date.now();
  await withEnv(localEnv(codex), () =>
    assert.rejects(call({ timeoutMs: 300 }), (e) => e.code === "codex_timeout" && !e.fatal),
  );
  assert.ok(Date.now() - started < 4000, "the timeout did not stop codex");
});

test("codex: an answer that is not JSON is codex_parse", async () => {
  const codex = fakeCodex({ answer: "I could not do that." });
  await withEnv(localEnv(codex), () => assert.rejects(call(), (e) => e.code === "codex_parse" && !e.fatal));
});

test("codex: a binary missing at call time is codex_spawn", async () => {
  await withEnv({ CI: undefined, PATH: "/nonexistent" }, () =>
    assert.rejects(call(), (e) => e.code === "codex_spawn" && !e.fatal),
  );
});

test("complete() routes a codex: ID to the codex transport", async () => {
  const codex = fakeCodex({ answer: ANSWER });
  fakeFetch();
  const { result } = await withEnv(localEnv(codex), () =>
    complete({ model: codexSol.id, entry: codexSol, system: "s", user: "u", schema: CRITIC_SCHEMA }),
  );
  assert.equal(result.model, "codex:gpt-6.1-sol");
});

for (const [name, opts, code] of [
  ["exit 1", { exit: 1, stderr: "boom" }, "codex_exit"],
  ["a timeout", { sleep: 5, answer: ANSWER }, "codex_timeout"],
  ["invalid JSON", { answer: "nope" }, "codex_parse"],
]) {
  test(`cli: codex ${name} falls back to the OpenRouter critic`, async () => {
    const cwd = tempRepo();
    const codex = fakeCodex(opts);
    const calls = fakeFetch({
      answers: {
        "x-ai/grok-4.3": [orReply(JSON.stringify({ findings: [finding()] }))],
        "anthropic/claude-haiku-5.5": [
          orReply(JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] })),
        ],
      },
    });
    const { result } = await withEnv(localEnv(codex, { PR_CRITIC_CODEX_TIMEOUT_MS: "300" }), () =>
      main({ argv: ["--base", "HEAD~1"], cwd }),
    );
    assert.equal(result.code, 0);
    const meta = result.result.meta;
    assert.equal(meta.chain.critic[0], "codex:gpt-6.1-sol");
    assert.equal(meta.chain.attempts[0].model, "codex:gpt-6.1-sol");
    assert.equal(meta.chain.attempts[0].error, code);
    assert.equal(meta.critic, "x-ai/grok-4.3");
    assert.equal(result.result.findings.length, 1);
    assert.ok(calls.some((c) => c.model === "x-ai/grok-4.3"));
  });
}

test("cli: a codex critic success costs $0 and is labelled as the subscription", async () => {
  const cwd = tempRepo();
  const codex = fakeCodex({ answer: ANSWER });
  fakeFetch({
    answers: {
      "anthropic/claude-haiku-5.5": [
        orReply(JSON.stringify({ verdicts: [{ index: 0, verdict: "CONFIRMED", reason: "r" }] }), {
          prompt_tokens: 1,
          completion_tokens: 1,
          cost: 0.001,
        }),
      ],
    },
  });
  const { result } = await withEnv(localEnv(codex), () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  const meta = result.result.meta;
  assert.equal(meta.critic, "codex:gpt-6.1-sol");
  assert.equal(meta.cost.critic, 0);
  assert.equal(meta.cost.paid_by.critic, "codex-subscription");
  assert.equal(meta.cost.paid_by.refuter, "openrouter");
});
