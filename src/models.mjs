import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Read rather than imported: JSON import attributes changed syntax within Node 20.
export const registry = JSON.parse(readFileSync(new URL("./models.json", import.meta.url), "utf8"));

const byId = new Map(registry.models.map((m) => [m.id, m]));

// Every prefix routed on, mapped to the family it reaches. An unknown prefix is refused
// rather than sent to OpenRouter as a model ID it does not have.
const PREFIXES = { openai: "openai", codex: "openai", anthropic: "anthropic" };
const CREDENTIAL = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.code = "config";
  }
}

function transportOf(id) {
  const m = /^([a-z0-9-]+):/.exec(id);
  if (!m) return "openrouter";
  if (!(m[1] in PREFIXES)) throw new ConfigError(`${id}: unknown transport prefix "${m[1]}:"`);
  return m[1];
}

// Family is the vendor, whichever transport reaches it: openai:, codex: and openai/
// are one reviewer as far as independence goes.
export function familyOf(id) {
  const listed = byId.get(id);
  if (listed) return listed.family;
  const t = transportOf(id);
  if (t !== "openrouter") return PREFIXES[t];
  assertFixedVendor(id);
  const slash = id.indexOf("/");
  if (slash <= 0) throw new ConfigError(`${id}: not a vendor/model ID`);
  return id.slice(0, slash).toLowerCase();
}

// The family rule holds only if the vendor in the ID is the vendor that answers.
// openrouter/ (auto, a router) and ~ aliases let OpenRouter pick the model. The :
// variants keep the model (openrouter.ai/docs/guides/routing/model-variants, checked
// 2026-11-27), but :nitro and :floor admit other service tiers and so other prices
// than the registry's, and the rest add little worth an exception: every : is refused.
function assertFixedVendor(id) {
  const slash = id.indexOf("/");
  const vendor = slash > 0 ? id.slice(0, slash).toLowerCase() : "";
  if (id.startsWith("~") || vendor === "openrouter" || (slash > 0 && id.slice(slash).includes(":"))) {
    throw new ConfigError(`${id}: lets OpenRouter choose the model or its price; name a fixed vendor/model ID`);
  }
}

export function resolveModel(id, role, { allowAny = false } = {}) {
  if (typeof id !== "string" || id === "") throw new ConfigError(`empty model ID for ${role}`);
  const transport = transportOf(id);
  const listed = byId.get(id);
  if (!listed) {
    // Before the allowlist, so the reason given is the real one with or without the flag.
    if (transport === "openrouter") assertFixedVendor(id);
    // A direct link is costed from the registry alone (OpenAI and Anthropic report
    // tokens, not money), so an unlisted one would never be debited against the cap.
    if (transport !== "openrouter") {
      throw new ConfigError(
        `${id} is not in src/models.json, so it has no price to debit against the cost cap; ` +
          "--allow-any-model covers OpenRouter IDs only",
      );
    }
    // The flag skips the allowlist only. Prices are unknown, so the cost of such a
    // model is whatever OpenRouter reports, and nothing bounds its output in advance.
    if (!allowAny) {
      throw new ConfigError(
        `${id} is not on the allowlist in src/models.json (pass --allow-any-model to use it locally)`,
      );
    }
    return { id, family: familyOf(id), transport, role, in_usd_per_m: null, out_usd_per_m: null, listed: false };
  }
  if (!allowAny && !listed.roles.includes(role)) {
    throw new ConfigError(`${id} is not allowed as ${role} (src/models.json lists it for ${listed.roles.join(", ")})`);
  }
  if (transport !== "openrouter" && typeof listed.api_model !== "string") {
    throw new ConfigError(`${id}: src/models.json gives no api_model for the ${transport}: transport`);
  }
  return { ...listed, transport, role, listed: true };
}

// `codex login status` exits 0 for an API-key login too. Only a ChatGPT login spends
// the subscription; an API-key login would bill that key, which is the openai: link's
// job and not this one's.
const codexProbes = new Map();
export function codexReady(env) {
  const probeEnv = { PATH: env.PATH ?? "", HOME: env.HOME ?? "", ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}) };
  const key = JSON.stringify(probeEnv);
  if (codexProbes.has(key)) return codexProbes.get(key);
  let reason = null;
  try {
    const out = execFileSync("codex", ["login", "status"], {
      env: probeEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    if (!/ChatGPT/.test(out)) reason = "codex: not logged in with ChatGPT";
  } catch (err) {
    reason = err.code === "ENOENT" ? "codex: not on PATH" : "codex: not logged in with ChatGPT";
  }
  codexProbes.set(key, reason);
  return reason;
}

function dropReason(id, transport, env) {
  if (env.PR_CRITIC_PAYER === "openrouter" && transport !== "openrouter") {
    return "PR_CRITIC_PAYER=openrouter keeps OpenRouter links only";
  }
  if (transport === "codex") {
    if (env.CI) return "codex: runs locally only (CI is set)";
    return codexReady(env);
  }
  const key = CREDENTIAL[transport];
  if (key && !env[key]) return `${key} is not set`;
  return null;
}

// The registry chain for a role, or the explicit IDs given, minus the links that
// cannot run here. Validation happens on what is left, so a CI run with only the
// OpenRouter key is checked as it will actually execute.
export function buildChain(role, env = process.env, { ids, allowAny = false } = {}) {
  const payer = env.PR_CRITIC_PAYER;
  if (payer !== undefined && payer !== "" && payer !== "openrouter") {
    throw new ConfigError(`PR_CRITIC_PAYER=${payer} is not understood (only "openrouter")`);
  }
  const wanted = ids ?? registry.chains[role];
  if (!wanted) throw new ConfigError(`no chain for role ${role}`);
  const links = [];
  const dropped = [];
  wanted.forEach((entry) => {
    const { id, role: linkRole } = typeof entry === "string" ? { id: entry, role } : entry;
    const transport = transportOf(id);
    // Resolve before looking at credentials, so a model off the allowlist is refused
    // as that even on a machine with no key.
    const model = resolveModel(id, linkRole, { allowAny });
    const reason = dropReason(id, transport, env);
    if (reason) {
      dropped.push({ id, reason });
      return;
    }
    links.push(model);
  });
  return { links, dropped };
}

const families = (chain) => [...new Set(chain.map((l) => l.family))];

export function assertChains({ critic, refuter }) {
  if (critic.length === 0) throw new ConfigError("critic chain is empty after dropping links without credentials");
  if (refuter.length === 0) throw new ConfigError("refuter chain is empty after dropping links without credentials");

  const claude = critic.find((l) => l.family === "anthropic");
  if (claude) throw new ConfigError(`${claude.id}: the critic is never Anthropic`);

  // Consecutive links of one family are retries of the same reviewer, not a second
  // opinion, so the chain needs a second family for a run where every link of the
  // first one fails.
  if (families(critic).length < 2) {
    throw new ConfigError(
      `critic chain ${critic.map((l) => l.id).join(" -> ")} has no second family for its fallback`,
    );
  }

  const criticFamilies = new Set(families(critic));
  for (const l of refuter) {
    if (criticFamilies.has(l.family)) {
      throw new ConfigError(`refuter ${l.id} shares family ${l.family} with the critic chain`);
    }
    if (l.family === "anthropic" && l.refuter_ok_anthropic !== true) {
      throw new ConfigError(`refuter ${l.id} is Anthropic and src/models.json does not set refuter_ok_anthropic`);
    }
  }
}
