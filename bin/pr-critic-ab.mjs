#!/usr/bin/env node
// Refuter A/B harness (PLAN.md Step 2). Replays stored critic findings against each
// candidate refuter on the diff the production refuter saw, and scores the verdicts
// against the labelled corpus that bin/ab-collect.mjs built.
//
// The corpus, the raw answers and the per-finding scores quote private code, so they
// stay in ~/dev/homelab-private-data/critic-ab. Only the aggregate results file is
// written into this repo.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectContext } from "../src/context.mjs";
import { Budget, estimateInputTokens } from "../src/cost.mjs";
import { resolveModel } from "../src/models.mjs";
import { complete } from "../src/llm.mjs";
import { runRefute } from "../src/refute.mjs";
import { refuseInsideWorktree } from "./ab-collect.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_DIR = join(homedir(), "dev", "homelab-private-data", "critic-ab");

export const CONTROL = "const-confirmed";
export const BASELINE = "google/gemini-3.1-pro-preview";
export const CANDIDATES = [
  BASELINE,
  "google/gemini-4-carbon",
  "deepseek/deepseek-v4.1-flash",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-haiku-5.5",
  CONTROL,
];
const KILL_SLACK = 0.05;
const EPS = 1e-9;
// homelab-71, 2026-11-27: gemini-4-carbon's price from 2026-12-01, USD per M tokens.
const CARBON_DECEMBER = { id: "google/gemini-4-carbon", in_usd_per_m: 4, out_usd_per_m: 20 };

// ---------------------------------------------------------------- pure parts

// A dismissed finding is scored only on a hand label. Its commit-heuristic acted_on
// (an edit within 10 lines later in the PR) did not hold up: 18 of 20 hand-labelled
// dismissed findings were not real, and no model kept any of the heuristic's 17.
export function truthOf(f) {
  if (f.hand_label === "real") return "real";
  if (f.hand_label === "not_real") return "not_real";
  if (f.stratum !== "posted") return null;
  if (f.label === "acted_on") return "real";
  if (f.label === "rejected") return "not_real";
  return null;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Every run with at least one scored finding. The order is shuffled, so a run cut
// short by the budget leaves a random subset rather than the oldest runs.
export function sampleRuns(corpus, { seed }) {
  const byRun = new Map();
  for (const f of corpus.findings) {
    if (!byRun.has(f.artifact_id)) byRun.set(f.artifact_id, []);
    byRun.get(f.artifact_id).push(f);
  }
  const runs = corpus.runs
    .filter((r) => r.kept !== false && byRun.has(r.artifact_id))
    .sort((a, b) => a.artifact_id - b.artifact_id);
  const scored = [];
  let heuristicOnly = 0;
  for (const r of runs) {
    const fs = byRun.get(r.artifact_id);
    if (fs.some((f) => truthOf(f) !== null)) scored.push(r);
    else if (fs.some((f) => f.stratum === "dismissed" && f.label === "acted_on")) heuristicOnly++;
  }
  const all = shuffle(scored, mulberry32(seed));
  return { runs: all, counts: { scored: scored.length, heuristic_only: heuristicOnly, total: all.length } };
}

// Output tokens a refuter call may use. Refuter answers are short JSON, but the
// reasoning models think first and that counts as output. Cached answers from the
// first run (2026-11-27, completion tokens incl. reasoning): Claude Haiku max 1963,
// Sonnet max 1520, Gemini 3.1 Pro max 6670, gemini-4-carbon max 15634 (p90 8390),
// deepseek-v4.1-flash max 25377 with 15 of 33 above 8000 and one answer cut off at
// 32000. 8000 would truncate the last two, so they keep headroom over their maximum.
const DEFAULT_ALLOWANCE = 8000;
const OUTPUT_ALLOWANCE = {
  "google/gemini-3.1-pro-preview": 12_000,
  "google/gemini-4-carbon": 24_000,
  "deepseek/deepseek-v4.1-flash": 32_000,
};

export function outputAllowance(id) {
  return OUTPUT_ALLOWANCE[id] ?? DEFAULT_ALLOWANCE;
}

// What one call reserves, and so what OpenRouter holds against the account balance:
// the prompt at the input rate plus the output allowance at the output rate. Budget.plan
// turns the same figure back into max_tokens, which then equals the allowance.
export function reservationFor({ entry, system, user, allowance, cap }) {
  if (entry?.in_usd_per_m == null || entry?.out_usd_per_m == null) return cap;
  const usd = (estimateInputTokens(system, user) * entry.in_usd_per_m + allowance * entry.out_usd_per_m) / 1e6;
  return Math.min(cap, usd + EPS);
}

export function findingKey(f) {
  return `${f.file}:${f.line ?? "?"}:${f.claim}`;
}

// Artifacts before v2 store survivors and dismissals apart, so the critic's order is
// lost and the order given (the corpus order) stands. Same order for every candidate.
export function orderFindings(list, raised) {
  if (!Array.isArray(raised) || raised.length === 0) return { findings: [...list], exact: false };
  const slots = new Map();
  raised.forEach((r, i) => {
    const k = findingKey(r);
    if (!slots.has(k)) slots.set(k, []);
    slots.get(k).push(i);
  });
  const matched = [];
  const rest = [];
  for (const f of list) {
    const q = slots.get(findingKey(f));
    if (q && q.length) matched.push({ f, at: q.shift() });
    else rest.push(f);
  }
  matched.sort((a, b) => a.at - b.at);
  return {
    findings: [...matched.map((m) => m.f), ...rest],
    exact: rest.length === 0 && matched.length === raised.length,
  };
}

export function constConfirmedAnswer(n) {
  return JSON.stringify({
    verdicts: Array.from({ length: n }, (_, index) => ({ index, verdict: "CONFIRMED", reason: "control" })),
  });
}

export function percentile(xs, p) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}

function bucket() {
  return { real: 0, kept: 0, not_real: 0, killed: 0 };
}

function rates(b) {
  return {
    real: b.real,
    kept: b.kept,
    keep: b.real ? b.kept / b.real : null,
    not_real: b.not_real,
    killed: b.killed,
    kill: b.not_real ? b.killed / b.not_real : null,
  };
}

// One call: its findings ({truth, stratum}) and the verdicts in the same order, or
// null when the call failed. A failed call is a miss for every finding in it: a real
// finding is not kept and a false one is not killed.
export function scoreCalls(calls) {
  const b = { overall: bucket(), posted: bucket(), dismissed: bucket() };
  const failures = {};
  let cost = 0;
  const lat = [];
  for (const c of calls) {
    cost += c.cost ?? 0;
    if (c.latency_ms != null) lat.push(c.latency_ms);
    if (c.failure) failures[c.failure] = (failures[c.failure] ?? 0) + 1;
    c.findings.forEach((f, i) => {
      if (f.truth == null) return;
      const v = c.verdicts ? c.verdicts[i] : null;
      for (const k of ["overall", f.stratum]) {
        if (f.truth === "real") {
          b[k].real++;
          if (v === "CONFIRMED") b[k].kept++;
        } else {
          b[k].not_real++;
          if (v === "REFUTED" || v === "UNPROVEN") b[k].killed++;
        }
      }
    });
  }
  return {
    overall: rates(b.overall),
    posted: rates(b.posted),
    dismissed: rates(b.dismissed),
    calls: calls.length,
    shape_failures: failures.shape ?? 0,
    failures,
    cost,
    p50_ms: percentile(lat, 0.5),
    p90_ms: percentile(lat, 0.9),
  };
}

// keep >= the baseline's and kill >= the baseline's minus 5 points, run by run, in
// every run the baseline has. The constant-CONFIRMED control must fail; if it passes,
// or is missing, the gate cannot tell a refuter from a rubber stamp.
export function gate(scores, { baseline = BASELINE, control = CONTROL, slack = KILL_SLACK } = {}) {
  const base = scores[baseline] ?? [];
  const verdicts = {};
  for (const [cand, runs] of Object.entries(scores)) {
    if (cand === baseline) {
      verdicts[cand] = { baseline: true, pass: true, runs: [] };
      continue;
    }
    const per = base.map((b, i) => {
      const s = runs[i];
      if (!s || !b) return { ok: false, why: "run missing" };
      const k = s.overall.keep;
      const kb = b.overall.keep;
      const x = s.overall.kill;
      const xb = b.overall.kill;
      const keepOk = k != null && kb != null && k >= kb - EPS;
      const killOk = x != null && xb != null && x >= xb - slack - EPS;
      return { ok: keepOk && killOk, keepOk, killOk };
    });
    verdicts[cand] = { baseline: false, pass: per.length > 0 && per.every((p) => p.ok), runs: per };
  }
  return { verdicts, broken: !verdicts[control] || verdicts[control].pass };
}

// The global budget across concurrent calls. Each call reserves up to the per-call cap
// before it starts and gives back what it did not spend, so concurrency cannot carry
// the run past the total.
export class Ledger {
  constructor(max, perCall) {
    this.max = max;
    this.perCall = perCall;
    this.spent = 0;
    this.reserved = 0;
  }

  reserve(want = this.perCall) {
    const avail = this.max - this.spent - this.reserved;
    const amt = avail < EPS ? 0 : Math.min(want, this.perCall, avail);
    this.reserved += amt;
    return amt;
  }

  // A full reservation of what the call wants (at most the per-call cap), waiting while
  // other calls hold what is missing. 0 means the spend itself leaves less than that
  // call: the budget is done.
  async acquire(want = this.perCall) {
    const need = Math.min(want, this.perCall);
    for (;;) {
      const amt = this.reserve(need);
      if (amt + EPS >= need) return amt;
      this.reserved -= amt;
      if (this.reserved <= EPS) return 0;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  settle(amt, cost) {
    this.reserved -= amt;
    this.spent += cost;
  }
}

// ---------------------------------------------------------------- replay input

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

const hasCommit = (sha, cwd) => tryGit(["cat-file", "-e", `${sha}^{commit}`], cwd) !== null;

const repoName = (repo) => repo.split("/").pop();

function ensureClone(repo, clonesDir) {
  const dir = join(clonesDir, repoName(repo));
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(clonesDir, { recursive: true });
    git(["clone", "-q", "--filter=blob:none", "--no-checkout", `https://github.com/${repo}.git`, dir], clonesDir);
  }
  return dir;
}

// The diff the production refuter saw: the run's head, against the base branch as it
// stood when the run happened (the corpus records the branch, e.g. origin/main, and
// the current tip of it would fold in everything merged since).
export function prepareContext(run, { clonesDir }) {
  const dir = ensureClone(run.repo, clonesDir);
  const cacheFile = join(dir, ".ab-context", `${run.artifact_id}.json`);
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));

  const fail = (reason) => {
    const out = { ok: false, reason };
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(out));
    return out;
  };

  const head = run.head_sha;
  if (!head) return fail("no head sha");
  if (!hasCommit(head, dir)) tryGit(["fetch", "-q", "origin", `+refs/pull/${run.pr}/head:refs/pr/${run.pr}`], dir);
  if (!hasCommit(head, dir)) tryGit(["fetch", "-q", "origin", head], dir);
  if (!hasCommit(head, dir)) return fail("head sha not fetchable");

  const m = /^origin\/(.+)$/.exec(run.base ?? "");
  if (!m) return fail("base is not an origin/ branch");
  const ref = `refs/remotes/origin/${m[1]}`;
  if (tryGit(["rev-parse", "--verify", "-q", ref], dir) === null) {
    tryGit(["fetch", "-q", "origin", `+refs/heads/${m[1]}:${ref}`], dir);
  }
  if (tryGit(["rev-parse", "--verify", "-q", ref], dir) === null) return fail("base branch gone");
  const baseSha = tryGit(["rev-list", "-1", "--first-parent", `--before=${run.artifact_created_at}`, ref], dir);
  if (!baseSha) return fail("no base commit before the run");
  if (tryGit(["merge-base", baseSha, head], dir) === null) return fail("no merge base");

  git(["update-ref", "--no-deref", "HEAD", head], dir);
  let ctx;
  try {
    ctx = collectContext({ base: baseSha, cwd: dir });
  } catch (e) {
    return fail(`diff failed: ${String(e.message).split("\n")[0].slice(0, 120)}`);
  }
  if (ctx.empty) return fail("empty diff");
  const out = { ok: true, base_sha: baseSha, head_sha: head, context: { diff: ctx.diff, truncated: ctx.truncated } };
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

function raisedFromArtifact(run, artifactDir) {
  const p = join(artifactDir, run.repo.replace("/", "__"), `${run.artifact_id}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")).meta?.raised_findings ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- calls

const safe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "__");

function classify(err, amt, need) {
  if (err.code === "cost_cap") return amt + EPS < need ? "budget_stop" : "cost_cap_call";
  if (err.fatal) return /OpenRouter 402/.test(err.message) ? "credit" : "fatal";
  if (/returned no content/.test(err.message)) return "empty";
  return "transport";
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callOne({ cand, r, run, ctx, findings, opts, ledger, state }) {
  const completeFn = opts.complete ?? complete;
  const sleep = opts.sleep ?? sleepMs;
  const creditWaitMs = opts.creditWaitMs ?? 60_000;
  const creditRetries = opts.creditRetries ?? 3;
  const cacheFile = join(opts.rawDir, safe(cand), String(r), `${repoName(run.repo)}-${run.pr}-${run.artifact_id}.json`);
  let raw = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : null;
  const cached = raw !== null;
  const save = (rec) => {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(rec, null, 2));
  };

  if (!raw && cand === CONTROL) {
    raw = { text: constConfirmedAnswer(findings.length), cost: 0, latency_ms: null, model: CONTROL };
    save(raw);
  }
  if (!raw && (state.stopped || opts.offline)) return { status: "not_called" };

  const entry = cand === CONTROL ? null : resolveModel(cand, "refuter");
  // The Anthropic candidates are refuters through OpenRouter here. resolveModel lets
  // them through (models.json lists them for the refuter role); the production CLI
  // refuses them in assertChains until refuter_ok_anthropic is set, and this harness
  // never calls assertChains.

  const transport = async (args) => {
    if (raw) {
      if (raw.error) {
        const e = new Error(raw.message ?? raw.error);
        e.ab = raw.error;
        throw e;
      }
      return { text: raw.text, usage: raw.usage ?? {}, cost: raw.cost ?? 0, model: raw.model ?? cand };
    }
    const need = reservationFor({
      entry: args.entry,
      system: args.system,
      user: args.user,
      allowance: outputAllowance(cand),
      cap: opts.maxCostCall,
    });
    let transportRetried = false;
    let creditTries = 0;
    for (;;) {
      if (state.stopped) {
        const e = new Error("stopped");
        e.ab = "budget_stop";
        throw e;
      }
      const amt = await ledger.acquire(need);
      if (amt === 0) {
        state.stopped ??= { reason: "budget spent", at: state.index };
        const e = new Error("budget spent");
        e.ab = "budget_stop";
        throw e;
      }
      const budget = new Budget(amt);
      const t0 = Date.now();
      try {
        const res = await completeFn({ ...args, budget });
        ledger.settle(amt, budget.spent);
        raw = {
          text: res.text,
          usage: res.usage,
          cost: budget.spent,
          estimated: res.estimated,
          model: res.model,
          latency_ms: Date.now() - t0,
        };
        save(raw);
        return { text: raw.text, usage: raw.usage, cost: raw.cost, model: raw.model };
      } catch (e) {
        ledger.settle(amt, budget.spent);
        let kind = classify(e, amt, need);
        if (kind === "transport" && !transportRetried) {
          transportRetried = true;
          continue;
        }
        // Out of credit can be momentary: the account tops itself up once the balance
        // drops below its threshold, and that takes a while to land.
        if (kind === "credit" && creditTries < creditRetries && !state.stopped) {
          creditTries++;
          console.error(`  ${cand} run ${r}: OpenRouter 402, retry ${creditTries}/${creditRetries} in ${creditWaitMs / 1000} s`);
          await sleep(creditWaitMs);
          continue;
        }
        if (kind === "credit") kind = "fatal";
        const rec = { error: kind, message: String(e.message).slice(0, 300), cost: budget.spent, latency_ms: Date.now() - t0 };
        if (kind === "empty" || kind === "cost_cap_call") save(rec);
        if ((kind === "budget_stop" || kind === "fatal") && !state.stopped) {
          const status = /OpenRouter (\d{3})/.exec(rec.message)?.[1] ?? "auth";
          const credit = /credit/i.test(rec.message) ? ", not enough credit for the request" : "";
          const tries = status === "402" ? ` after ${creditTries} retries ${creditWaitMs / 1000} s apart` : "";
          state.stopped = { reason: kind === "fatal" ? `OpenRouter ${status}${credit}${tries}` : "budget spent", at: state.index };
        }
        raw = rec;
        e.ab = kind;
        e.abCost = budget.spent;
        throw e;
      }
    }
  };

  try {
    const out = await runRefute({
      model: cand,
      context: ctx.context,
      findings,
      entry,
      stage: "refuter",
      call: transport,
    });
    const byIndex = new Map(out.verdicts.map((v) => [v.index, v.verdict]));
    return {
      status: "ok",
      cached,
      verdicts: findings.map((_, i) => byIndex.get(i)),
      cost: raw.cost ?? 0,
      latency_ms: raw.latency_ms ?? null,
      usage: raw.usage ?? null,
    };
  } catch (e) {
    const kind = e.ab ?? (e.code === "shape" || e.code === "parse" ? "shape" : "transport");
    if (kind === "budget_stop" || kind === "fatal") return { status: "not_called", stop: kind };
    // An empty answer is a wrong shape too: the link produced nothing usable.
    const failure = kind === "empty" ? "shape" : kind;
    return {
      status: "failure",
      cached,
      failure,
      verdicts: null,
      cost: raw?.cost ?? e.abCost ?? 0,
      latency_ms: raw?.latency_ms ?? null,
      usage: raw?.usage ?? null,
    };
  }
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- report

const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const frac = (n, d) => `${n}/${d}`;
const money = (x) => `$${x.toFixed(4)}`;
const secs = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

function decemberCost(calls) {
  let c = 0;
  for (const x of calls) {
    const u = x.usage;
    if (!u || u.prompt_tokens == null) return null;
    c += (u.prompt_tokens * CARBON_DECEMBER.in_usd_per_m + (u.completion_tokens ?? 0) * CARBON_DECEMBER.out_usd_per_m) / 1e6;
  }
  return c;
}

function renderMarkdown(rep) {
  const L = [];
  const p = (s = "") => L.push(s);
  p("# Refuter A/B results, 2026-11");
  p();
  p(`Run on ${rep.date} by \`bin/pr-critic-ab.mjs\` (PLAN.md Step 2). Aggregates only: the corpus, the`);
  p("raw answers and the per-finding scores are private and stay outside this repo.");
  p();
  p("## Input");
  p();
  const c = rep.corpus;
  p(`- Corpus: ${c.findings} findings from ${c.runs_kept} kept runs (${c.runs_total} artifacts scanned).`);
  p(`- Ground truth: real = posted acted_on (${c.posted_acted_on}) and dismissed hand-labelled real (${c.hand_real}); not real = posted rejected (${c.posted_rejected}) and dismissed hand-labelled not real (${c.hand_not_real}). The ${c.dismissed_acted_on} dismissed acted_on labels from the commit heuristic are not scored.`);
  p(`- Sample (seed ${rep.seed}): every run with a scored finding, ${rep.sample.total} runs. ${rep.sample.heuristic_only} runs whose only label is a heuristic acted_on are left out.`);
  p(`- Unreproducible: ${rep.unreproducible.total} (${Object.entries(rep.unreproducible.by).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}).`);
  const sf = rep.scored_findings;
  p(`- Scored: ${rep.scored_runs} runs, ${rep.runs_per_candidate} runs per candidate. Posted: ${sf.posted.real} real, ${sf.posted.not_real} not real. Dismissed: ${sf.dismissed.real} real, ${sf.dismissed.not_real} not real. ${sf.unlabelled} unscored findings were replayed alongside them.`);
  p(`- Replay order: exact for ${rep.order_exact} runs, corpus order (posted, then dismissed) for ${rep.scored_runs - rep.order_exact}.`);
  if (rep.stopped) {
    p(`- Stopped early: ${rep.stopped.reason}, at sampled run ${rep.stopped.at + 1} of ${rep.sample.total}. ${rep.scored_runs} of ${rep.prepared} reproducible runs were finished by every candidate in every repeat, and only those are scored.`);
  } else if (rep.scored_runs < rep.prepared) {
    p(`- Incomplete: ${rep.prepared - rep.scored_runs} of ${rep.prepared} reproducible runs were not called for every candidate (offline run or no key), and are not scored.`);
  } else {
    p(`- Completed: all ${rep.prepared} reproducible runs were called for every candidate.`);
  }
  p(`- Spend: ${money(rep.recorded_cost)} across every call made, cached ones from earlier invocations included; this invocation spent ${money(rep.spend)} of a ${money(rep.budget)} budget (per call at most ${money(rep.max_cost_call)}).`);
  p();
  p("Keep = CONFIRMED / real (UNPROVEN counts as not kept). Kill = (REFUTED + UNPROVEN) / not real.");
  p("A shape failure is a miss for every finding in that call.");
  p();
  p("## Gate");
  p();
  const nRuns = rep.runs_per_candidate;
  p(`Pass: keep >= the baseline's and kill >= the baseline's minus 5 points, in all ${nRuns} runs. Baseline \`${BASELINE}\`, scored fresh on the same input.`);
  p();
  const idx = Array.from({ length: nRuns }, (_, i) => i);
  p(`| Candidate | ${idx.map((i) => `Run ${i + 1} keep / kill`).join(" | ")} | Verdict |`);
  p(`|---|${idx.map(() => "---|").join("")}---|`);
  for (const cand of rep.candidates) {
    const runs = rep.scores[cand] ?? [];
    const v = rep.gate.verdicts[cand];
    const cell = (i) => (runs[i] ? `${pct(runs[i].overall.keep)} / ${pct(runs[i].overall.kill)}` : "missing");
    const verdict = v?.baseline ? "baseline" : v?.pass ? "PASS" : "fail";
    p(`| \`${cand}\` | ${idx.map(cell).join(" | ")} | ${verdict} |`);
  }
  p();
  p(rep.gate.broken ? "**GATE BROKEN**: the constant-CONFIRMED control passed, so no default moves on this result." : "The control fails the gate, as it must.");
  p();
  p("## Per candidate");
  for (const cand of rep.candidates) {
    p();
    p(`### \`${cand}\``);
    p();
    p("| Run | Stratum | Keep | Kill | Cost | p50 | p90 | Shape failures | Other failures |");
    p("|---|---|---|---|---|---|---|---|---|");
    (rep.scores[cand] ?? []).forEach((s, i) => {
      for (const st of ["overall", "posted", "dismissed"]) {
        const x = s[st];
        const first = st === "overall";
        const other = Object.entries(s.failures).filter(([k]) => k !== "shape").map(([k, n]) => `${k} ${n}`).join(", ") || "0";
        p(
          `| ${i + 1} | ${st} | ${pct(x.keep)} (${frac(x.kept, x.real)}) | ${pct(x.kill)} (${frac(x.killed, x.not_real)}) | ` +
            `${first ? money(s.cost) : ""} | ${first ? secs(s.p50_ms) : ""} | ${first ? secs(s.p90_ms) : ""} | ` +
            `${first ? s.shape_failures : ""} | ${first ? other : ""} |`,
        );
      }
    });
    if (cand === CARBON_DECEMBER.id) {
      const dec = rep.carbon_december;
      p();
      p(`Price note: from 2026-12-01 gemini-4-carbon costs $${CARBON_DECEMBER.in_usd_per_m}/$${CARBON_DECEMBER.out_usd_per_m} per M input/output tokens (homelab-71), against $2/$10 when this ran.` +
        (dec ? ` The same calls at the December price: ${dec.map((d, i) => `run ${i + 1} ${d == null ? "n/a" : money(d)}`).join(", ")}.` : ""));
    }
  }
  p();
  p("## Biases");
  p();
  p("- Replay order is approximate. Artifacts before v2 keep survivors and dismissals apart, so findings are replayed posted first, then dismissed. Every candidate sees the same order.");
  p("- The 20 hand labels on dismissed findings are by Codex (codex-cli 0.172.0), not Johann.");
  p("- The rule \"thread resolved, file unchanged = rejected\" was demoted on 2026-11-27; those findings are unlabelled now, which leaves the posted stratum with few not-real findings.");
  p("- The base is the base branch as it stood at the run's time (first parent before the artifact's timestamp), and the head is the PR head; for pull_request runs production diffed the merge commit, so the replayed diff can differ where the base moved during the run.");
  p("- Dismissed acted_on labels from the commit heuristic (a change within 10 lines later in the PR) are not scored: in the first run (2026-11-27) no candidate kept any of 17, and 18 of the 20 hand-labelled dismissed findings were not real. They are still replayed when they share a run with a scored finding.");
  p("- The dismissed stratum's truth rests on 20 hand labels, so its rates move a lot with one finding.");
  p(`- Refuter verdicts are noisy run to run: in the first run the fresh baseline confirmed only 45-73% of the posted findings it had confirmed in production. That is why each candidate runs ${nRuns} times and must pass in every run.`);
  p("- Runs 1 and 2 reuse the cached answers of the first run (2026-11-27), which was sized to the old $0.40 per-call cap; run 3 and every new call were sized to the prompt plus a per-model output allowance (8000 tokens, more for the three reasoning refuters). One cached deepseek answer spent the whole 32000-token ceiling on reasoning and is replayed as a shape failure.");
  p();
  return L.join("\n");
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const out = {
    corpus: join(PRIVATE_DIR, "corpus.json"),
    rawDir: join(PRIVATE_DIR, "raw-ab"),
    artifactDir: join(PRIVATE_DIR, "raw"),
    scores: join(PRIVATE_DIR, "ab-scores-2026-11.json"),
    outMd: join(REPO_ROOT, "ab", "results-2026-11.md"),
    clonesDir: join(process.env.TMPDIR || tmpdir(), "critic-ab-clones"),
    seed: 20261127,
    runs: 3,
    budget: 25,
    maxCostCall: 0.4,
    // OpenRouter holds each call's worst case against the balance; ten at once tripped
    // a 402 on 2026-11-27 before the account's auto top-up could land.
    concurrency: 3,
    candidates: CANDIDATES,
    prepareOnly: false,
    offline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const num = () => {
      const n = Number(next());
      if (!(n > 0)) throw new Error(`${a} must be a positive number`);
      return n;
    };
    if (a === "--corpus") out.corpus = next();
    else if (a === "--raw-dir") out.rawDir = next();
    else if (a === "--scores") out.scores = next();
    else if (a === "--out") out.outMd = next();
    else if (a === "--clones-dir") out.clonesDir = next();
    else if (a === "--seed") out.seed = num();
    else if (a === "--runs") out.runs = num();
    else if (a === "--budget") out.budget = num();
    else if (a === "--max-cost-call") out.maxCostCall = num();
    else if (a === "--concurrency") out.concurrency = num();
    else if (a === "--candidates") out.candidates = next().split(",");
    else if (a === "--limit-runs") out.limitRuns = num();
    else if (a === "--prepare-only") out.prepareOnly = true;
    else if (a === "--offline") out.offline = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.candidates[0] !== BASELINE || !out.candidates.includes(CONTROL)) {
    throw new Error(`--candidates must start with ${BASELINE} and include ${CONTROL}`);
  }
  return out;
}

const USAGE = `pr-critic-ab [--runs 3] [--budget 25] [--max-cost-call 0.40] [--concurrency 3]
             [--prepare-only] [--offline] [--limit-runs n] [--candidates a,b,...] [--corpus p] [--raw-dir d]
             [--scores p] [--out results.md] [--clones-dir d] [--seed n]

  Replays the corpus findings against each candidate refuter (OPENROUTER_API_KEY) and
  writes aggregate results. Raw answers are cached under --raw-dir, so a re-score
  never calls a model again. --prepare-only builds the diffs and estimates the cost;
  --offline scores what is cached plus the control. Exit 2: the gate is broken.`;

function corpusSummary(corpus) {
  const fs = corpus.findings;
  const n = (pred) => fs.filter(pred).length;
  return {
    findings: fs.length,
    runs_total: corpus.runs.length,
    runs_kept: corpus.runs.filter((r) => r.kept !== false).length,
    posted_acted_on: n((f) => f.stratum === "posted" && f.label === "acted_on"),
    posted_rejected: n((f) => f.stratum === "posted" && f.label === "rejected"),
    hand_real: n((f) => f.hand_label === "real"),
    hand_not_real: n((f) => f.hand_label === "not_real"),
    dismissed_acted_on: n((f) => f.stratum === "dismissed" && f.label === "acted_on" && f.hand_label == null),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  for (const p of [opts.rawDir, opts.scores, opts.clonesDir]) refuseInsideWorktree(p, REPO_ROOT);

  const corpus = JSON.parse(readFileSync(opts.corpus, "utf8"));
  const { runs: sampled, counts } = sampleRuns(corpus, { seed: opts.seed });
  console.error(`sample: ${counts.total} runs with a scored finding (${counts.heuristic_only} heuristic-only runs left out)`);

  const byRun = new Map();
  for (const f of corpus.findings) {
    if (!byRun.has(f.artifact_id)) byRun.set(f.artifact_id, []);
    byRun.get(f.artifact_id).push(f);
  }

  // Phase 1: every diff, before any money is spent.
  const prepared = [];
  const unrepro = {};
  for (const [i, run] of sampled.entries()) {
    let ctx;
    try {
      ctx = prepareContext(run, { clonesDir: opts.clonesDir });
    } catch (e) {
      ctx = { ok: false, reason: `clone failed: ${String(e.message).split("\n")[0].slice(0, 120)}` };
    }
    if (!ctx.ok) {
      unrepro[ctx.reason] = (unrepro[ctx.reason] ?? 0) + 1;
      console.error(`[${i + 1}/${sampled.length}] ${run.artifact_id}: unreproducible (${ctx.reason})`);
      continue;
    }
    const { findings, exact } = orderFindings(byRun.get(run.artifact_id), raisedFromArtifact(run, opts.artifactDir));
    prepared.push({ index: i, run, ctx, findings, exact });
  }
  const unreproTotal = Object.values(unrepro).reduce((a, b) => a + b, 0);
  console.error(`prepared ${prepared.length}, unreproducible ${unreproTotal}`);

  if (opts.prepareOnly) {
    const chars = prepared.reduce((n, p) => n + p.ctx.context.diff.length, 0);
    const tokens = Math.ceil(chars / 4) + prepared.length * 1500;
    console.error(`input across prepared runs: ~${tokens} tokens per candidate per run`);
    for (const cand of opts.candidates) {
      if (cand === CONTROL) continue;
      const e = resolveModel(cand, "refuter");
      const est = opts.runs * ((tokens * e.in_usd_per_m) / 1e6 + (prepared.length * 4000 * e.out_usd_per_m) / 1e6);
      console.error(`  ${cand}: ~$${est.toFixed(2)} for ${opts.runs} runs (output guessed at 4000 tokens per call)`);
    }
    return 0;
  }

  // Phase 2: one pool over every (run, candidate, repeat), run-major, so runs finish
  // roughly in order and a budget stop leaves whole runs that every candidate finished.
  const ledger = new Ledger(opts.budget, opts.maxCostCall);
  const state = { stopped: null, index: 0 };
  const tasks = [];
  const done = new Map();
  for (const [k, p] of prepared.entries()) {
    // A smoke test calls the first N runs only; the rest count as not called.
    if (opts.limitRuns && k >= opts.limitRuns) {
      for (const cand of opts.candidates) for (let r = 1; r <= opts.runs; r++) tasks.push(async () => ({ k, cand, r, status: "not_called" }));
      continue;
    }
    const plain = p.findings.map((f) => ({
      file: f.file,
      line: f.line,
      severity: f.severity,
      claim: f.claim,
      failure_scenario: f.failure_scenario,
    }));
    const per = opts.candidates.length * opts.runs;
    for (const cand of opts.candidates) {
      for (let r = 1; r <= opts.runs; r++) {
        tasks.push(async () => {
          state.index = Math.max(state.index, p.index);
          const out = { k, cand, r, ...(await callOne({ cand, r, run: p.run, ctx: p.ctx, findings: plain, opts, ledger, state })) };
          const n = (done.get(k) ?? 0) + 1;
          done.set(k, n);
          if (n === per) {
            console.error(`[${k + 1}/${prepared.length}] run ${p.run.artifact_id} done, spent $${ledger.spent.toFixed(2)}`);
          }
          return out;
        });
      }
    }
  }
  const all = await pool(tasks, opts.concurrency);
  const results = prepared.map((p, k) => ({ p, calls: all.filter((c) => c.k === k) }));

  // Score only runs every candidate finished in every run.
  const complete_ = results.filter(({ calls }) => calls.every((c) => c.status !== "not_called"));
  const scores = {};
  const perCand = {};
  for (const cand of opts.candidates) {
    scores[cand] = [];
    perCand[cand] = [];
    for (let r = 1; r <= opts.runs; r++) {
      const calls = complete_.map(({ p, calls }) => {
        const c = calls.find((x) => x.cand === cand && x.r === r);
        return {
          findings: p.findings.map((f) => ({ truth: truthOf(f), stratum: f.stratum })),
          verdicts: c.verdicts,
          failure: c.status === "failure" ? c.failure : null,
          cost: c.cost,
          latency_ms: cand === CONTROL ? null : c.latency_ms,
          usage: c.usage,
        };
      });
      scores[cand].push(scoreCalls(calls));
      perCand[cand].push(calls);
    }
  }
  const g = gate(scores);
  const scoredFindings = { posted: { real: 0, not_real: 0 }, dismissed: { real: 0, not_real: 0 }, unlabelled: 0 };
  for (const { p } of complete_) {
    for (const f of p.findings) {
      const t = truthOf(f);
      if (t == null) scoredFindings.unlabelled++;
      else scoredFindings[f.stratum][t]++;
    }
  }

  const rep = {
    date: new Date().toISOString().slice(0, 10),
    seed: opts.seed,
    corpus: corpusSummary(corpus),
    sample: counts,
    unreproducible: { total: unreproTotal, by: unrepro },
    prepared: prepared.length,
    scored_runs: complete_.length,
    scored_findings: scoredFindings,
    runs_per_candidate: opts.runs,
    order_exact: complete_.filter(({ p }) => p.exact).length,
    stopped: state.stopped,
    spend: ledger.spent,
    recorded_cost: all.reduce((n, c) => n + (c.cost ?? 0), 0),
    budget: opts.budget,
    max_cost_call: opts.maxCostCall,
    candidates: opts.candidates,
    scores,
    gate: g,
    carbon_december: perCand[CARBON_DECEMBER.id]?.map(decemberCost) ?? null,
  };

  writeFileSync(opts.outMd, renderMarkdown(rep));
  mkdirSync(dirname(opts.scores), { recursive: true });
  writeFileSync(
    opts.scores,
    JSON.stringify(
      {
        ...rep,
        per_run: results.map(({ p, calls }) => ({
          repo: p.run.repo,
          pr: p.run.pr,
          artifact_id: p.run.artifact_id,
          base_sha: p.ctx.base_sha,
          head_sha: p.ctx.head_sha,
          scored: complete_.some((x) => x.p === p),
          findings: p.findings.map((f) => ({ id: f.id, stratum: f.stratum, truth: truthOf(f) })),
          calls: calls.map((c) => ({ cand: c.cand, run: c.r, status: c.status, failure: c.failure ?? null, verdicts: c.verdicts ?? null, cost: c.cost ?? 0, latency_ms: c.latency_ms ?? null, cached: c.cached ?? false })),
        })),
        unreproducible_runs: sampled
          .filter((r) => !prepared.some((p) => p.run === r))
          .map((r) => ({ repo: r.repo, pr: r.pr, artifact_id: r.artifact_id })),
      },
      null,
      2,
    ),
  );
  console.error(`wrote ${opts.outMd} and ${opts.scores}`);
  console.error(`spent $${ledger.spent.toFixed(4)}${state.stopped ? `, stopped: ${state.stopped.reason}` : ""}`);
  for (const [cand, v] of Object.entries(g.verdicts)) {
    console.error(`  ${cand}: ${v.baseline ? "baseline" : v.pass ? "PASS" : "fail"}`);
  }
  if (g.broken) {
    console.error("GATE BROKEN");
    return 2;
  }
  return 0;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`pr-critic-ab: ${err.message}`);
      process.exit(1);
    },
  );
}
