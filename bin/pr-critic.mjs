#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectContext, fetchPrIntent, shouldSkip } from "../src/context.mjs";
import { runCritic } from "../src/critic.mjs";
import { runRefute } from "../src/refute.mjs";
import { postReview, postNoReviewNotice, clearNoReviewNotice } from "../src/post.mjs";
import { registry, familyOf, buildChain, assertChains, ConfigError } from "../src/models.mjs";
import { Budget } from "../src/cost.mjs";

const DEFAULT_MAX_COST = 0.5;

function parseArgs(argv) {
  const out = { base: null, pr: null, repo: null, json: null, excludes: [], keepUnproven: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") out.base = next();
    else if (a === "--pr") out.pr = next();
    else if (a === "--repo") out.repo = next();
    else if (a === "--critic-model") out.critic = next();
    else if (a === "--critic-fallback-model") out.criticFallback = next();
    else if (a === "--refuter-model") out.refuter = next();
    else if (a === "--allow-any-model") out.allowAny = true;
    else if (a === "--max-cost") out.maxCost = next();
    else if (a === "--json") out.json = next();
    else if (a === "--exclude") out.excludes.push(next());
    else if (a === "--keep-unproven") out.keepUnproven = true;
    else if (a === "--no-skip") out.noSkip = true;
    else if (a === "--post") out.post = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

const USAGE = `pr-critic --base <ref> [--pr <n> --repo <owner/name>] [options]

  --base <ref>            base to diff against (default: origin/HEAD, then main)
  --pr <n> --repo <o/r>   fetch the PR title+body as the stated intent
  --critic-model <id>     replaces the critic chain (default ${registry.chains.critic.join(" -> ")})
  --critic-fallback-model <id>
                          used when the critic fails; default: the first OpenRouter
                          link of the default chain from another family
  --refuter-model <id>    replaces the refuter chain with this model, then the default
                          chain's last OpenRouter link
                          (default ${registry.chains.refuter.join(" -> ")})
  --allow-any-model       accept IDs that are not in src/models.json (the family rules
                          still apply)
  --max-cost <usd>        stop before a call that could take the run past this
                          (default ${DEFAULT_MAX_COST})
  --exclude <pathspec>    extra path to leave out of the diff (repeatable)
  --keep-unproven         keep findings the refuter could not settle
  --no-skip               review even when every changed file is documentation or
                          marked linguist-generated in the base tree
  --post                  publish survivors as one GitHub review (needs GITHUB_TOKEN)
  --json <path>           also write the full result as JSON

Chains, allowed models and prices: src/models.json. The prefix picks the transport,
and a link runs only when it can:
  openai:<model>      OpenAI API on credit; needs OPENAI_API_KEY
  anthropic:<model>   Anthropic API on credit; needs ANTHROPIC_API_KEY
  codex:<model>       local codex CLI on the ChatGPT subscription; needs CI unset,
                      codex on PATH and \`codex login status\` showing a ChatGPT login
  vendor/model        OpenRouter; needs OPENROUTER_API_KEY
PR_CRITIC_PAYER=openrouter keeps OpenRouter links only. Prints surviving findings as
JSON on stdout.`;

function inferRepo(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = /github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/.exec(url);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function defaultBase(cwd) {
  for (const ref of ["origin/HEAD", "origin/main", "main", "origin/master", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, stdio: "ignore" });
      return ref;
    } catch {
      /* try next */
    }
  }
  return "main";
}

// The job stays green on a model outage, so the pull request is the only place the
// absence of a review can be seen. Never let this throw over the real failure.
async function announceNoReview({ repo, pr, post, stage, models, reason }) {
  const token = process.env.GITHUB_TOKEN;
  if (!post || !repo || !pr || !token) return;
  try {
    const notice = await postNoReviewNotice({ repo, pr, token, stage, models, reason });
    console.error(`posted "no review ran" notice ${notice.id}`);
  } catch (e) {
    console.error(`could not post the "no review ran" notice: ${e.message}`);
  }
}

// Explicit flags form the chain as they always did: the critic, then its fallback.
// Only the fallback flag left out picks one, from another family, so the family rule
// still has something to hold on to.
function explicitCriticIds(args) {
  const critic = args.critic || null;
  if (critic === null && args.criticFallback === undefined) return null;
  const primary = critic ?? registry.chains.critic.find((id) => !id.includes(":"));
  if (args.criticFallback === "") return [{ id: primary, role: "critic" }];
  const fallback =
    args.criticFallback ??
    registry.chains.critic.find((id) => !id.includes(":") && familyOf(id) !== familyOf(primary));
  return [
    { id: primary, role: "critic" },
    ...(fallback ? [{ id: fallback, role: "fallback" }] : []),
  ];
}

// An explicit refuter keeps an OpenRouter fallback, the last OpenRouter link of the
// default chain, so a spent credit pool behind an anthropic: refuter still ends in a
// review.
function explicitRefuterIds(args) {
  if (!args.refuter) return null;
  const fallback = [...registry.chains.refuter].reverse().find((id) => !id.includes(":"));
  return [
    { id: args.refuter, role: "refuter" },
    ...(fallback && fallback !== args.refuter ? [{ id: fallback, role: "refuter" }] : []),
  ];
}

function configure(args, env) {
  const maxCost = args.maxCost === undefined ? DEFAULT_MAX_COST : Number(args.maxCost);
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    throw new ConfigError(`--max-cost ${JSON.stringify(args.maxCost)} is not a positive number`);
  }
  const allowAny = Boolean(args.allowAny);
  const critic = buildChain("critic", env, { ids: explicitCriticIds(args) ?? undefined, allowAny });
  const refuter = buildChain("refuter", env, { ids: explicitRefuterIds(args) ?? undefined, allowAny });
  assertChains({ critic: critic.links, refuter: refuter.links });
  return { maxCost, critic, refuter };
}

const VENDOR = { openai: "OpenAI", anthropic: "Anthropic" };

// A credit key that is rejected fails over like an empty credit pool, but never
// quietly: otherwise a dead key would show up a month later as an OpenRouter bill. In
// Actions the warning goes to stdout, where the runner reads workflow commands; locally
// to stderr, so stdout stays the result JSON.
function warnRejected(transport) {
  const line = `::warning::${transport} credit key rejected`;
  if (process.env.GITHUB_ACTIONS === "true") console.log(line);
  else console.error(line);
}

// Tries each link in order until one answers. A dead OpenRouter key fails the same way
// on every OpenRouter link, and a cost-cap trip would trip again, so both end the
// chain. A rejected credit key moves on, unless no link is left: then it is as final
// as a dead OpenRouter key.
export async function runChain({ links, role, attempts, warnings = [], call }) {
  let last;
  const rejected = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    // Links of the first family are retries of the critic; the first change of family
    // is the fallback, and its cost is counted as such.
    const stage = role === "refuter" ? "refuter" : link.family === links[0].family ? "critic" : "fallback";
    try {
      const out = await call(link, stage);
      attempts.push({ role, stage, model: link.id, ok: true, cost: out.cost, paid_by: out.paid_by });
      for (const t of rejected) warnings.push(`${VENDOR[t] ?? t} credit key rejected, fell back to ${link.id}`);
      return out;
    } catch (err) {
      attempts.push({ role, stage, model: link.id, ok: false, error: err.code ?? (err.fatal ? "fatal" : "error"), message: err.message });
      if (err.code === "auth" && (link.transport === "openai" || link.transport === "anthropic")) {
        warnRejected(link.transport);
        if (!rejected.includes(link.transport)) rejected.push(link.transport);
        if (i === links.length - 1) err.fatal = true;
      }
      if (err.fatal || err.code === "cost_cap" || i === links.length - 1) throw err;
      console.error(`${role} ${link.id} failed: ${err.message}`);
      console.error(`retrying with ${links[i + 1].id}`);
      last = err;
    }
  }
  throw last;
}

// Nothing is posted for a skipped diff: a review saying "skipped" on every docs PR is
// noise. A "no review ran" notice from an earlier push is stale once the diff is one
// that needs no review, so it goes.
async function skip({ args, repo, base, skipped }) {
  console.error(`not reviewed: ${skipped.reason} (--no-skip forces a review)`);
  const result = { base, findings: [], meta: { skipped } };
  const token = process.env.GITHUB_TOKEN;
  if (args.post && repo && args.pr && token) {
    try {
      const cleared = await clearNoReviewNotice({ repo, pr: args.pr, token });
      if (cleared) console.error(`removed the stale "no review ran" notice ${cleared}`);
    } catch (e) {
      console.error(`could not remove the stale "no review ran" notice: ${e.message}`);
    }
  }
  const text = JSON.stringify(result, null, 2);
  if (args.json) writeFileSync(args.json, text);
  console.log(text);
  return { code: 0, result };
}

async function run({ argv, cwd = process.cwd(), env = process.env }) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { code: 0 };
  }

  const repo = args.repo ?? inferRepo(cwd);

  // Local git only, so it comes before the configuration: a docs-only change needs no
  // key and no model, and is skipped even where none is configured.
  const base = args.base ?? defaultBase(cwd);
  const context = collectContext({ base, cwd, excludes: args.excludes });
  if (context.empty) {
    console.error(`No changes against ${base}.`);
    const result = { base, findings: [], meta: { empty: true } };
    console.log(JSON.stringify(result, null, 2));
    return { code: 0, result };
  }
  if (context.attrError) console.error(`${context.attrError}; treating every file as not generated`);
  const skipped = args.noSkip ? null : shouldSkip(context.files);
  if (skipped) return skip({ args, repo, base, skipped });

  // Before any network call: a configuration error does not fix itself, so it is
  // said on the pull request and the check goes red.
  let config;
  try {
    config = configure(args, env);
  } catch (err) {
    if (err.code !== "config") throw err;
    await announceNoReview({ repo, pr: args.pr, post: args.post, stage: "config", models: [], reason: err.message });
    console.error(`pr-critic: ${err.message}`);
    return { code: 3 };
  }
  const { critic: criticChain, refuter: refuterChain, maxCost } = config;
  for (const d of [...criticChain.dropped, ...refuterChain.dropped]) console.error(`skipped ${d.id}: ${d.reason}`);

  const prIntent = await fetchPrIntent({
    repo,
    pr: args.pr,
    token: process.env.GITHUB_TOKEN,
  });
  const intent = prIntent ? `${prIntent.title}\n\n${prIntent.body}` : context.commits;

  console.error(
    `base=${base} critic=${criticChain.links.map((l) => l.id).join(" -> ")} ` +
      `refuter=${refuterChain.links.map((l) => l.id).join(" -> ")} max-cost=$${maxCost}`,
  );

  const budget = new Budget(maxCost);
  const attempts = [];
  const warnings = [];
  const chainMeta = {
    critic: criticChain.links.map((l) => l.id),
    refuter: refuterChain.links.map((l) => l.id),
    dropped: [...criticChain.dropped, ...refuterChain.dropped],
    attempts,
  };
  let critic;
  let refute;
  let stage = "critic";
  try {
    critic = await runChain({
      links: criticChain.links,
      role: "critic",
      attempts,
      warnings,
      call: (link, s) => runCritic({ model: link.id, entry: link, budget, stage: s, context, intent }),
    });
    console.error(`critic: ${critic.findings.length} finding(s)`);
    stage = "refuter";
    refute = await runChain({
      links: refuterChain.links,
      role: "refuter",
      attempts,
      warnings,
      call: (link, s) => runRefute({ model: link.id, entry: link, budget, stage: s, context, findings: critic.findings }),
    });
  } catch (err) {
    await announceNoReview({
      repo,
      pr: args.pr,
      post: args.post,
      stage,
      models: attempts.filter((a) => a.role === stage).map((a) => a.model),
      reason: err.message,
    });
    throw err;
  }

  const byIndex = new Map(refute.verdicts.map((v) => [v.index, v]));

  const judged = critic.findings.map((f, i) => {
    // A finding the refuter never returned a verdict for has not been cleared;
    // treat the silence as UNPROVEN rather than quietly promoting it.
    const v = byIndex.get(i) ?? { verdict: "UNPROVEN", reason: "no verdict returned" };
    return { ...f, verdict: v.verdict, refutation: v.reason };
  });

  const keep = new Set(args.keepUnproven ? ["CONFIRMED", "UNPROVEN"] : ["CONFIRMED"]);
  const survivors = judged.filter((f) => keep.has(f.verdict));

  const result = {
    base,
    findings: survivors,
    dismissed: judged.filter((f) => !keep.has(f.verdict)),
    meta: {
      critic: critic.model,
      refuter: refute.model,
      raised: critic.findings.length,
      survived: survivors.length,
      truncated: context.truncated,
      usage: { critic: critic.usage, refuter: refute.usage },
      // paid_by names the transport's funding, not proof of who paid: a credit key
      // can bill purchased credit once the included credit is gone.
      cost: { ...budget.summary(), paid_by: { critic: critic.paid_by ?? null, refuter: refute.paid_by ?? null } },
      chain: chainMeta,
      warnings,
    },
  };

  if (args.post) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("--post needs GITHUB_TOKEN");
    if (!repo || !args.pr) throw new Error("--post needs --pr and a resolvable repo");
    const posted = await postReview({
      repo,
      pr: args.pr,
      token,
      diff: context.diff,
      findings: survivors,
      meta: result.meta,
    });
    result.posted = posted;
    console.error(
      `posted review ${posted.id}: ${posted.inline} inline, ${posted.orphans} in summary` +
        (posted.degraded ? " (degraded: an anchor was rejected)" : ""),
    );
    try {
      const cleared = await clearNoReviewNotice({ repo, pr: args.pr, token });
      if (cleared) console.error(`removed the stale "no review ran" notice ${cleared}`);
    } catch (e) {
      console.error(`could not remove the stale "no review ran" notice: ${e.message}`);
    }
  }

  const text = JSON.stringify(result, null, 2);
  if (args.json) writeFileSync(args.json, text);
  console.log(text);
  console.error(`survived: ${survivors.length}/${critic.findings.length} cost=$${budget.spent.toFixed(4)}`);
  return { code: 0, result };
}

// Returns {code, result} and never throws, so the tests can drive it in-process.
export async function main(opts) {
  try {
    return await run(opts);
  } catch (err) {
    console.error(`pr-critic: ${err.message}`);
    // Exit 3 says "this will not fix itself": credit exhausted, key revoked or
    // no longer authorised, or a configuration that names a model it may not use.
    return { code: err.fatal || err.code === "config" ? 3 : 1 };
  }
}

// Imported by the tests; run when executed, including through an npx bin symlink.
const self = fileURLToPath(import.meta.url);
let invoked = null;
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : null;
} catch {
  /* not a file path */
}
if (invoked === self) {
  main({ argv: process.argv.slice(2) }).then(({ code }) => process.exit(code));
}
