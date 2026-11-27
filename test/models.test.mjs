import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, familyOf, buildChain, assertChains, registry } from "../src/models.mjs";

const OR_ONLY = { OPENROUTER_API_KEY: "k" };

test("an unlisted model is refused, naming the allowlist", () => {
  assert.throws(() => resolveModel("openai/gpt-6.2-astra-pro", "critic"), /not on the allowlist/);
});

test("--allow-any-model lets an unlisted OpenRouter model through", () => {
  const m = resolveModel("openai/gpt-6.2-astra-pro", "critic", { allowAny: true });
  assert.equal(m.family, "openai");
  assert.equal(m.in_usd_per_m, null);
});

test("IDs that let OpenRouter pick the vendor are refused as a critic, even with --allow-any-model", async () => {
  const { main } = await import("../bin/pr-critic.mjs");
  const { tempRepo, fakeFetch, withEnv } = await import("./helpers.mjs");
  const realFetch = globalThis.fetch;
  try {
    for (const id of ["openrouter/auto", "~anthropic/claude-x", "Anthropic/claude-sonnet-5.5"]) {
      const calls = fakeFetch();
      const { result } = await withEnv(OR_ONLY, () =>
        main({ argv: ["--base", "HEAD~1", "--critic-model", id, "--allow-any-model"], cwd: tempRepo() }),
      );
      assert.equal(result.code, 3, id);
      assert.deepEqual(calls, [], `${id}: no call was made`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const id of [
    "openrouter/auto", "~anthropic/claude-x", "x-ai/grok-4.3:nitro", "openai/gpt-6.1-sol:floor",
    "@preset/x", "x-ai/grok-4.3@preset/x",
  ]) {
    assert.throws(() => resolveModel(id, "critic", { allowAny: true }), /OpenRouter/, id);
    assert.throws(() => resolveModel(id, "critic"), /OpenRouter/, id);
  }
  assert.equal(familyOf("Anthropic/claude-sonnet-5.5"), "anthropic");
});

test("an unlisted openai:, anthropic: or codex: ID is refused even with --allow-any-model: it has no price to debit", () => {
  for (const id of ["openai:gpt-9", "anthropic:claude-opus-9", "codex:gpt-9"]) {
    assert.throws(() => resolveModel(id, "critic", { allowAny: true }), /no price/, id);
  }
});

test("a listed model in a role it is not listed for is refused", () => {
  assert.throws(() => resolveModel("x-ai/grok-4.3", "refuter"), /not allowed as refuter/);
});

test("an unknown transport prefix is refused, even with --allow-any-model", () => {
  assert.throws(() => resolveModel("foo:bar", "critic", { allowAny: true }), /unknown transport prefix/);
});

test("familyOf maps every transport of a vendor to one family", () => {
  assert.equal(familyOf("openai/gpt-6.1-sol"), "openai");
  assert.equal(familyOf("openai:gpt-6.1-sol"), "openai");
  assert.equal(familyOf("codex:gpt-6.2-sol"), "openai");
  assert.equal(familyOf("anthropic:claude-haiku-5.5"), "anthropic");
  assert.equal(familyOf("x-ai/grok-4.3"), "x-ai");
});

test("registry prices are numbers for every listed model", () => {
  for (const m of registry.models) {
    assert.equal(typeof m.in_usd_per_m, "number", m.id);
    assert.equal(typeof m.out_usd_per_m, "number", m.id);
    assert.equal(m.checked, "2026-11-27", m.id);
  }
});

test("an OpenRouter-only env yields grok then openai/gpt-6.1-sol, and the default chains pass", () => {
  const critic = buildChain("critic", OR_ONLY);
  const refuter = buildChain("refuter", OR_ONLY);
  assert.deepEqual(critic.links.map((l) => l.id), ["x-ai/grok-4.3", "openai/gpt-6.1-sol"]);
  assert.deepEqual(refuter.links.map((l) => l.id), ["anthropic/claude-haiku-5.5", "google/gemini-3.1-pro-preview"]);
  assert.ok(critic.dropped.some((d) => d.id === "openai:gpt-6.1-sol"));
  assertChains({ critic: critic.links, refuter: refuter.links });
});

test("with no OpenRouter key every OpenRouter link is dropped and the chain is a config error", () => {
  const critic = buildChain("critic", {});
  assert.deepEqual(critic.links, []);
  assert.throws(
    () => assertChains({ critic: critic.links, refuter: buildChain("refuter", {}).links }),
    /critic chain is empty/,
  );
});

test("PR_CRITIC_PAYER=openrouter keeps OpenRouter links only, even with other credentials", () => {
  const env = { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", PR_CRITIC_PAYER: "openrouter" };
  const critic = buildChain("critic", env);
  assert.ok(critic.links.every((l) => l.transport === "openrouter"));
  const payerDrops = critic.dropped.filter((d) => /PR_CRITIC_PAYER/.test(d.reason)).map((d) => d.id);
  assert.deepEqual(payerDrops, ["openai:gpt-6.1-sol", "codex:gpt-6.1-sol"]);
});

test("an unknown PR_CRITIC_PAYER is refused", () => {
  assert.throws(() => buildChain("critic", { ...OR_ONLY, PR_CRITIC_PAYER: "me" }), /PR_CRITIC_PAYER/);
});

test("an x-ai refuter with an x-ai critic is refused by the family rule", () => {
  const grok = resolveModel("x-ai/grok-4.3", "critic");
  const gpt = resolveModel("openai/gpt-6.1-sol", "critic");
  const grokRefuter = resolveModel("x-ai/grok-4.3", "refuter", { allowAny: true });
  assert.throws(() => assertChains({ critic: [grok, gpt], refuter: [grokRefuter] }), /shares family x-ai/);
});

test("an anthropic critic is refused, even with --allow-any-model", () => {
  const claude = resolveModel("anthropic/claude-sonnet-5.5", "critic", { allowAny: true });
  const unlisted = resolveModel("anthropic/claude-opus-9", "critic", { allowAny: true });
  const grok = resolveModel("x-ai/grok-4.3", "critic");
  const gem = resolveModel("google/gemini-3.1-pro-preview", "refuter");
  assert.throws(() => assertChains({ critic: [claude, grok], refuter: [gem] }), /never Anthropic/);
  assert.throws(() => assertChains({ critic: [grok, unlisted], refuter: [gem] }), /never Anthropic/);
});

test("a critic chain with one family is refused; consecutive same-family links are retries", () => {
  const a = resolveModel("openai/gpt-6.1-sol", "critic");
  const b = resolveModel("openai/gpt-6.2-sol", "critic");
  const gem = resolveModel("google/gemini-3.1-pro-preview", "refuter");
  assert.throws(() => assertChains({ critic: [a, b], refuter: [gem] }), /second family/);
});

test("an anthropic refuter is refused unless the registry marks it refuter_ok_anthropic", () => {
  const grok = resolveModel("x-ai/grok-4.3", "critic");
  const gpt = resolveModel("openai/gpt-6.1-sol", "critic");
  const sonnet = resolveModel("anthropic/claude-sonnet-5.5", "refuter");
  assert.throws(() => assertChains({ critic: [grok, gpt], refuter: [sonnet] }), /refuter_ok_anthropic/);
  assertChains({ critic: [grok, gpt], refuter: [{ ...sonnet, refuter_ok_anthropic: true }] });
  // Haiku 5.5 passed the 2026-11 refuter A/B (ab/results-2026-11.md); Sonnet was not measured.
  assertChains({ critic: [grok, gpt], refuter: [resolveModel("anthropic/claude-haiku-5.5", "refuter")] });
});
