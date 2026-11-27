import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChain, assertChains, resolveModel, registry } from "../src/models.mjs";
import { fakeCodex } from "./helpers.mjs";

const OR = { OPENROUTER_API_KEY: "k" };
const ids = (chain) => chain.links.map((l) => l.id);

test("CI=true with only the OpenRouter key gives an OpenRouter-only chain", () => {
  const codex = fakeCodex();
  const env = { ...OR, CI: "true", PATH: `${codex.dir}:/usr/bin:/bin` };
  const critic = buildChain("critic", env);
  const refuter = buildChain("refuter", env);
  assert.deepEqual(ids(critic), ["x-ai/grok-4.3", "openai/gpt-6.1-sol"]);
  assert.deepEqual(ids(refuter), ["anthropic/claude-haiku-5.5", "google/gemini-3.1-pro-preview"]);
  assert.match(critic.dropped.find((d) => d.id === "codex:gpt-6.1-sol").reason, /CI is set/);
  assert.match(critic.dropped.find((d) => d.id === "openai:gpt-6.1-sol").reason, /OPENAI_API_KEY/);
  assert.match(refuter.dropped.find((d) => d.id === "anthropic:claude-haiku-5.5").reason, /ANTHROPIC_API_KEY/);
  assertChains({ critic: critic.links, refuter: refuter.links });
});

test("with OPENAI_API_KEY the critic chain starts at openai:", () => {
  const critic = buildChain("critic", { ...OR, CI: "true", OPENAI_API_KEY: "o" });
  assert.deepEqual(ids(critic), ["openai:gpt-6.1-sol", "x-ai/grok-4.3", "openai/gpt-6.1-sol"]);
  assert.equal(critic.links[0].transport, "openai");
  assert.equal(critic.links[0].api_model, "gpt-6.1-sol");
});

test("with no OpenAI key and a logged-in codex on PATH, the critic chain starts at codex:", () => {
  const codex = fakeCodex();
  const critic = buildChain("critic", { ...OR, PATH: `${codex.dir}:/usr/bin:/bin` });
  assert.deepEqual(ids(critic), ["codex:gpt-6.1-sol", "x-ai/grok-4.3", "openai/gpt-6.1-sol"]);
  assert.match(codex.log(), /ARGV login status/);
});

test("a codex that is not logged in, or not on PATH, is dropped with the reason", () => {
  const out = fakeCodex({ loggedIn: false });
  const loggedOut = buildChain("critic", { ...OR, PATH: `${out.dir}:/usr/bin:/bin` });
  assert.equal(loggedOut.links[0].id, "x-ai/grok-4.3");
  assert.match(loggedOut.dropped.find((d) => d.id === "codex:gpt-6.1-sol").reason, /not logged in with ChatGPT/);

  const missing = buildChain("critic", { ...OR, PATH: "/nonexistent" });
  assert.match(missing.dropped.find((d) => d.id === "codex:gpt-6.1-sol").reason, /not on PATH/);
});

test("both credit links set: openai: first, codex: second, then OpenRouter", () => {
  const codex = fakeCodex();
  const critic = buildChain("critic", { ...OR, OPENAI_API_KEY: "o", PATH: `${codex.dir}:/usr/bin:/bin` });
  assert.deepEqual(ids(critic), ["openai:gpt-6.1-sol", "codex:gpt-6.1-sol", "x-ai/grok-4.3", "openai/gpt-6.1-sol"]);
});

test("with ANTHROPIC_API_KEY the refuter chain starts at anthropic:, then the same model on OpenRouter", () => {
  const refuter = buildChain("refuter", { ...OR, CI: "true", ANTHROPIC_API_KEY: "a" });
  assert.deepEqual(ids(refuter), [
    "anthropic:claude-haiku-5.5",
    "anthropic/claude-haiku-5.5",
    "google/gemini-3.1-pro-preview",
  ]);
  assert.equal(refuter.links[0].api_model, "claude-haiku-5-5");
  const critic = buildChain("critic", { ...OR, CI: "true" });
  assertChains({ critic: critic.links, refuter: refuter.links });
});

test("PR_CRITIC_PAYER=openrouter with every key set and a logged-in codex keeps OpenRouter links only", () => {
  const codex = fakeCodex();
  const env = {
    ...OR,
    OPENAI_API_KEY: "o",
    ANTHROPIC_API_KEY: "a",
    PR_CRITIC_PAYER: "openrouter",
    PATH: `${codex.dir}:/usr/bin:/bin`,
  };
  const critic = buildChain("critic", env);
  const refuter = buildChain("refuter", env);
  assert.ok([...critic.links, ...refuter.links].every((l) => l.transport === "openrouter"));
  assert.deepEqual(ids(critic), ["x-ai/grok-4.3", "openai/gpt-6.1-sol"]);
  assert.deepEqual(ids(refuter), ["anthropic/claude-haiku-5.5", "google/gemini-3.1-pro-preview"]);
  assert.equal(codex.log(), "", "the payer rule drops codex before probing it");
});

test("the openai:, codex: and anthropic: prefixes resolve; an unknown prefix is still refused", () => {
  assert.equal(resolveModel("openai:gpt-6.1-sol", "critic").transport, "openai");
  assert.equal(resolveModel("codex:gpt-6.2-sol", "critic").api_model, "gpt-6.2-sol");
  assert.equal(resolveModel("anthropic:claude-haiku-5.5", "refuter").api_model, "claude-haiku-5-5");
  assert.throws(() => resolveModel("foo:bar", "critic", { allowAny: true }), /unknown transport prefix/);
});

test("every prefixed registry entry names its API model explicitly", () => {
  for (const m of registry.models.filter((m) => m.id.includes(":"))) {
    assert.equal(typeof m.api_model, "string", m.id);
    assert.ok(m.api_model.length > 0, m.id);
  }
});

test("the registry chains are the plan's defaults", () => {
  assert.deepEqual(registry.chains.critic, ["openai:gpt-6.1-sol", "codex:gpt-6.1-sol", "x-ai/grok-4.3", "openai/gpt-6.1-sol"]);
  assert.deepEqual(registry.chains.refuter, [
    "anthropic:claude-haiku-5.5",
    "anthropic/claude-haiku-5.5",
    "google/gemini-3.1-pro-preview",
  ]);
});
