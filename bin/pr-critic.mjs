#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { collectContext, fetchPrIntent } from "../src/context.mjs";
import { runCritic } from "../src/critic.mjs";
import { runRefute } from "../src/refute.mjs";
import { postReview, postNoReviewNotice, clearNoReviewNotice } from "../src/post.mjs";

const DEFAULTS = {
  // Cross-family by design: the critic is not an Anthropic model, and the refuter
  // is not the critic's family either. The fallback is a third family, so the
  // separation still holds on the run where the first critic fails.
  critic: "x-ai/grok-4.3",
  criticFallback: "openai/gpt-5.1",
  refuter: "google/gemini-3.1-pro-preview",
};

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
    else if (a === "--json") out.json = next();
    else if (a === "--exclude") out.excludes.push(next());
    else if (a === "--keep-unproven") out.keepUnproven = true;
    else if (a === "--post") out.post = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

const USAGE = `pr-critic --base <ref> [--pr <n> --repo <owner/name>] [options]

  --base <ref>            base to diff against (default: origin/HEAD, then main)
  --pr <n> --repo <o/r>   fetch the PR title+body as the stated intent
  --critic-model <id>     default ${DEFAULTS.critic}
  --critic-fallback-model <id>
                          used when the critic fails; default ${DEFAULTS.criticFallback},
                          empty string to disable
  --refuter-model <id>    default ${DEFAULTS.refuter}
  --exclude <pathspec>    extra path to leave out of the diff (repeatable)
  --keep-unproven         keep findings the refuter could not settle
  --post                  publish survivors as one GitHub review (needs GITHUB_TOKEN)
  --json <path>           also write the full result as JSON

Needs OPENROUTER_API_KEY. Prints surviving findings as JSON on stdout.`;

function inferRepo(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim();
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const cwd = process.cwd();
  const base = args.base ?? defaultBase(cwd);
  const criticModel = args.critic ?? DEFAULTS.critic;
  const fallbackModel = (args.criticFallback ?? DEFAULTS.criticFallback) || null;
  const refuterModel = args.refuter ?? DEFAULTS.refuter;

  const context = collectContext({ base, cwd, excludes: args.excludes });
  if (context.empty) {
    console.error(`No changes against ${base}.`);
    console.log(JSON.stringify({ base, findings: [], meta: { empty: true } }, null, 2));
    return 0;
  }

  const repo = args.repo ?? inferRepo(cwd);
  const prIntent = await fetchPrIntent({
    repo,
    pr: args.pr,
    token: process.env.GITHUB_TOKEN,
  });
  const intent = prIntent ? `${prIntent.title}\n\n${prIntent.body}` : context.commits;

  console.error(`base=${base} critic=${criticModel} refuter=${refuterModel}`);

  let attempted = [criticModel];
  let critic;
  let refute;
  let stage = "critic";
  try {
    try {
      critic = await runCritic({ model: criticModel, context, intent });
    } catch (err) {
      // A dead key will fail the same way on any model, so only a model-specific
      // failure is worth a second call.
      if (err.fatal || !fallbackModel) throw err;
      console.error(`critic ${criticModel} failed: ${err.message}`);
      console.error(`retrying with ${fallbackModel}`);
      attempted.push(fallbackModel);
      critic = await runCritic({ model: fallbackModel, context, intent });
    }
    console.error(`critic: ${critic.findings.length} finding(s)`);
    stage = "refuter";
    attempted = [refuterModel];
    refute = await runRefute({ model: refuterModel, context, findings: critic.findings });
  } catch (err) {
    await announceNoReview({
      repo,
      pr: args.pr,
      post: args.post,
      stage,
      models: attempted,
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
  console.error(`survived: ${survivors.length}/${critic.findings.length}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`pr-critic: ${err.message}`);
    // Exit 3 says "this will not fix itself": credit exhausted, key revoked or
    // no longer authorised.
    process.exit(err.fatal ? 3 : 1);
  },
);
