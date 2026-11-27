#!/usr/bin/env node
// Builds the labelled corpus the refuter A/B test scores against (PLAN.md Step 1).
// The corpus quotes code and describes bugs from private repos, so it is written
// outside this public repo and never next to it: see ab/README.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_OWNER = "HINTERLAND-software";
const DEFAULT_REPOS = ["homelab", "meal-planner", "simple-frame", "Dalbi"];
const LINE_WINDOW = 10;
const THREAD_LINE_SLACK = 2;
const EVIDENCE_MAX = 200;
const RATE_FLOOR = 1000;

export const REJECT_RE =
  /false positive|not a bug|not applicable|n\/a|wrong|incorrect|by design|won'?t fix|intended|stimmt nicht|kein fehler|falsch/i;

// ---------------------------------------------------------------- pure parts

export function prNumberFromName(name) {
  const m = /^pr-critic-(\d+)$/.exec(name ?? "");
  return m ? Number(m[1]) : null;
}

// Oldest first, because the oldest artifacts are the next to expire.
export function selectArtifacts(artifacts, { since, maxPerRepo }) {
  const cutoff = Date.parse(since);
  return artifacts
    .filter((a) => !a.expired && prNumberFromName(a.name) !== null && Date.parse(a.created_at) >= cutoff)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
    .slice(0, maxPerRepo);
}

// A run that raised nothing has nothing to refute. A run whose findings were all
// dismissed posted no review, and is exactly the stratum the posted labels miss.
export function keepRun(json) {
  return Number(json?.meta?.raised) > 0;
}

// Old-side positions of every change in a unified-diff patch: a removed line at its
// own number, an added line at the old line it was inserted before. Context lines
// are not changes, so they never count towards the ±10 window.
export function changedOldLines(patch) {
  const out = [];
  let old = 0;
  let header = null;
  for (const raw of (patch ?? "").split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (h) {
      old = Number(h[1]);
      header = h[0];
      continue;
    }
    if (header === null) continue;
    if (raw.startsWith("-")) {
      out.push({ line: old, header });
      old++;
    } else if (raw.startsWith("+")) {
      out.push({ line: old, header });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      old++;
    }
  }
  return out;
}

export function findTouch(files, file, line, window = LINE_WINDOW) {
  const f = files.find((x) => x.filename === file || x.previous_filename === file);
  if (!f) return { fileTouched: false, hit: null };
  if (line == null || !f.patch) return { fileTouched: true, hit: null };
  const hit = changedOldLines(f.patch).find((c) => Math.abs(c.line - line) <= window) ?? null;
  return { fileTouched: true, hit };
}

export function rejectionIn(body) {
  const m = REJECT_RE.exec(body ?? "");
  return m ? m[0] : null;
}

function isBotComment(c) {
  return Boolean(c.isBot) || /\[bot\]$/.test(c.author ?? "") || c.author === "github-actions";
}

function isCriticBot(c) {
  return c.author === "github-actions" || c.author === "github-actions[bot]";
}

// The critic's own thread for this finding: same path, line within ±2 (the line
// moves when a thread goes outdated, so originalLine counts too), opened by the
// bot inside the run's time window. A thread quoting the claim beats a nearer one.
export function matchThread(threads, finding, { notBefore, notAfter }) {
  const lo = Date.parse(notBefore);
  const hi = Date.parse(notAfter);
  const cands = [];
  for (const t of threads) {
    const first = t.comments?.[0];
    if (!first || !isCriticBot(first) || t.path !== finding.file || finding.line == null) continue;
    const at = Date.parse(first.createdAt);
    if (!(at >= lo && at <= hi)) continue;
    const lines = [t.line, t.originalLine].filter((n) => n != null);
    const dist = Math.min(...lines.map((n) => Math.abs(n - finding.line)));
    if (!(dist <= THREAD_LINE_SLACK)) continue;
    cands.push({ t, dist, at, quotes: Boolean(finding.claim) && (first.body ?? "").includes(finding.claim) });
  }
  cands.sort((a, b) => Number(b.quotes) - Number(a.quotes) || b.at - a.at || a.dist - b.dist);
  return cands[0]?.t ?? null;
}

function clip(s) {
  const flat = String(s).replace(/\s+/g, " ").trim();
  return flat.length > EVIDENCE_MAX ? `${flat.slice(0, EVIDENCE_MAX - 1)}…` : flat;
}

function hitEvidence(touch) {
  return clip(`${touch.range ?? ""} ${touch.hit.header} (change at old line ${touch.hit.line})`);
}

export function labelPosted({ touch, thread }) {
  const reply = (thread?.comments ?? []).slice(1).find((c) => !isBotComment(c) && rejectionIn(c.body));
  if (reply && touch.hit) {
    return { label: "unlabelled", evidence: clip(`conflict: reply "${reply.body}" vs ${hitEvidence(touch)}`) };
  }
  if (touch.hit) return { label: "acted_on", evidence: hitEvidence(touch) };
  if (reply) return { label: "rejected", evidence: clip(`${reply.author}: ${reply.body}`) };
  // Not a rejection: a thread is also resolved, file untouched, when the fix landed in
  // another file. Kept as evidence for a hand label (relabel of 2026-11-27).
  if (thread?.isResolved && touch.fileTouched === false) {
    return { label: "unlabelled", evidence: clip(`thread resolved, file unchanged ${touch.range ?? ""}`) };
  }
  return { label: "unlabelled", evidence: thread ? "" : "no matching thread" };
}

export function labelDismissed({ touch }) {
  if (touch.hit) return { label: "acted_on", evidence: hitEvidence(touch) };
  return { label: "unlabelled", evidence: "" };
}

// Resolves through the deepest existing ancestor, so a symlink or `..` cannot walk
// the corpus back into the repo.
function realish(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}

export function refuseInsideWorktree(path, toplevel) {
  const p = realish(path);
  const top = realpathSync(toplevel);
  const rel = relative(top, p);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`refusing to write ${p}: it is inside the git worktree ${top}, and the corpus must never land in a repo`);
  }
  return p;
}

// A `/critic` comment run carries the default branch as its head, not the PR's, so
// the PR head at the time is the newest PR commit made before the artifact.
export function resolveRunHead(artifact, pr) {
  const wr = artifact.workflow_run ?? {};
  if (wr.head_branch && wr.head_branch === pr.headRefName) return wr.head_sha;
  const at = Date.parse(artifact.created_at);
  const before = (pr.commits ?? [])
    .filter((c) => Date.parse(c.committedDate) <= at)
    .sort((a, b) => Date.parse(b.committedDate) - Date.parse(a.committedDate));
  return before[0]?.oid ?? null;
}

export function summarize(corpus) {
  const strata = {};
  for (const name of ["posted", "dismissed"]) {
    const fs = corpus.findings.filter((f) => f.stratum === name);
    const labelled = fs.filter((f) => f.label !== "unlabelled");
    strata[name] = {
      acted_on: fs.filter((f) => f.label === "acted_on").length,
      rejected: fs.filter((f) => f.label === "rejected").length,
      unlabelled: fs.filter((f) => f.label === "unlabelled").length,
      total: fs.length,
      labelled: labelled.length,
      labelled_prs: new Set(labelled.map((f) => `${f.repo}#${f.pr}`)).size,
    };
  }
  return {
    runs_scanned: corpus.scanned,
    runs_kept: corpus.runs.filter((r) => r.kept !== false).length,
    strata,
  };
}

// ---------------------------------------------------------------- GitHub I/O

let apiCalls = 0;

function gh(args, { binary = false } = {}) {
  apiCalls++;
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("gh", args, {
        encoding: binary ? "buffer" : "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const msg = String(e.stderr ?? e.message);
      if (attempt >= 1 || /HTTP 40[134]|HTTP 410|HTTP 422/.test(msg)) {
        const err = new Error(`gh ${args.slice(0, 2).join(" ")}: ${msg.trim().split("\n").pop()}`);
        err.stderr = msg;
        throw err;
      }
    }
  }
}

function coreRemaining() {
  return Number(gh(["api", "rate_limit", "--jq", ".resources.core.remaining"]).trim());
}

function listArtifacts(repo) {
  const out = gh([
    "api",
    "--paginate",
    `repos/${repo}/actions/artifacts?per_page=100`,
    "--jq",
    '.artifacts[] | select(.name | startswith("pr-critic-"))',
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function downloadJson(repo, artifact, cacheDir, tmp) {
  const cached = cacheDir && join(cacheDir, repo.replace("/", "__"), `${artifact.id}.json`);
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const zip = join(tmp, `${artifact.id}.zip`);
  writeFileSync(zip, gh(["api", `repos/${repo}/actions/artifacts/${artifact.id}/zip`], { binary: true }));
  let text;
  try {
    text = execFileSync("unzip", ["-p", zip, "pr-critic.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(zip, { force: true });
  }
  if (!text) throw new Error("pr-critic.json missing from the artifact");
  const json = JSON.parse(text);
  if (cached) {
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, text);
  }
  return json;
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    headRefName headRefOid state mergeCommit{oid}
    commits(last:100){ nodes{ commit{ oid committedDate } } }
    reviewThreads(first:100, after:$after){
      pageInfo{ hasNextPage endCursor }
      nodes{ path line originalLine isResolved
        comments(first:50){ nodes{ author{ login __typename } body createdAt } } }
    }
  } } }`;

function fetchPr(repo, number) {
  const [owner, name] = repo.split("/");
  let after = null;
  let pr = null;
  const threads = [];
  do {
    const args = ["api", "graphql", "-f", `query=${PR_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`];
    if (after) args.push("-F", `after=${after}`);
    const data = JSON.parse(gh(args)).data.repository.pullRequest;
    if (!data) throw new Error(`${repo}#${number} not found`);
    pr ??= {
      headRefName: data.headRefName,
      headRefOid: data.headRefOid,
      state: data.state,
      mergeCommit: data.mergeCommit?.oid ?? null,
      commits: data.commits.nodes.map((n) => n.commit),
    };
    for (const t of data.reviewThreads.nodes) {
      threads.push({
        path: t.path,
        line: t.line,
        originalLine: t.originalLine,
        isResolved: t.isResolved,
        comments: t.comments.nodes.map((c) => ({
          author: c.author?.login ?? "ghost",
          isBot: c.author?.__typename === "Bot",
          body: c.body,
          createdAt: c.createdAt,
        })),
      });
    }
    after = data.reviewThreads.pageInfo.hasNextPage ? data.reviewThreads.pageInfo.endCursor : null;
  } while (after);
  pr.threads = threads;
  return pr;
}

function fetchCompare(repo, a, b) {
  if (a === b) return [];
  const data = JSON.parse(gh(["api", `repos/${repo}/compare/${a}...${b}?per_page=100`]));
  return data.files ?? [];
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { repos: [], since: "2026-09-01", maxPerRepo: 150, out: null, cacheDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--repo") out.repos.push(next());
    else if (a === "--since") out.since = next();
    else if (a === "--max-per-repo") out.maxPerRepo = Number(next());
    else if (a === "--out") out.out = next();
    else if (a === "--cache-dir") out.cacheDir = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.repos.length === 0) out.repos = DEFAULT_REPOS;
  out.repos = out.repos.map((r) => (r.includes("/") ? r : `${DEFAULT_OWNER}/${r}`));
  if (Number.isNaN(Date.parse(out.since))) throw new Error(`--since is not a date: ${out.since}`);
  if (!(out.maxPerRepo > 0)) throw new Error("--max-per-repo must be a positive number");
  return out;
}

const USAGE = `ab-collect --out <path> [--repo <name|owner/name>]... [--since YYYY-MM-DD]
           [--max-per-repo N] [--cache-dir <dir>]

  Builds the labelled corpus for the refuter A/B test from pr-critic-<n> artifacts.
  --out        required; refused when it is inside a git worktree of this repo
  --repo       repeatable; default ${DEFAULT_REPOS.join(", ")} under ${DEFAULT_OWNER}
  --since      artifacts created on or after this date (default 2026-09-01)
  --max-per-repo  default 150, oldest first
  --cache-dir  keep each downloaded pr-critic.json here and reuse it on a rerun`;

function toplevels() {
  const tops = new Set();
  for (const cwd of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    try {
      tops.add(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      /* not in a worktree */
    }
  }
  return [...tops];
}

function guardPath(p) {
  let resolved = resolve(p);
  for (const top of toplevels()) resolved = refuseInsideWorktree(p, top);
  return resolved;
}

function findingRecord({ f, i, stratum, run, label }) {
  return {
    id: `${run.repo}#${run.pr}/${run.artifact_id}/${stratum[0]}${i}`,
    repo: run.repo,
    pr: run.pr,
    artifact_id: run.artifact_id,
    run_id: run.run_id,
    head_sha: run.head_sha,
    base: run.base,
    stratum,
    prod_verdict: f.verdict ?? null,
    prod_reason: f.refutation ?? null,
    file: f.file ?? null,
    line: f.line ?? null,
    severity: f.severity ?? null,
    claim: f.claim ?? null,
    failure_scenario: f.failure_scenario ?? null,
    label: label.label,
    label_evidence: label.evidence,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.out) throw new Error("--out is required");
  const outPath = guardPath(args.out);
  const cacheDir = args.cacheDir ? guardPath(args.cacheDir) : null;

  const remaining = coreRemaining();
  console.error(`GitHub core rate limit: ${remaining} remaining`);
  if (remaining < RATE_FLOOR) throw new Error(`only ${remaining} core requests left (floor ${RATE_FLOOR}); try after the reset`);

  const tmp = mkdtempSync(join(tmpdir(), "ab-collect-"));
  const runs = [];
  const findings = [];
  let scanned = 0;
  let stoppedEarly = null;
  const prCache = new Map();
  const compareCache = new Map();

  try {
    outer: for (const repo of args.repos) {
      const picked = selectArtifacts(listArtifacts(repo), { since: args.since, maxPerRepo: args.maxPerRepo });
      console.error(`${repo}: ${picked.length} artifact(s) selected`);
      for (const artifact of picked) {
        if (scanned > 0 && scanned % 50 === 0) {
          const left = coreRemaining();
          if (left < RATE_FLOOR) {
            stoppedEarly = `core rate limit at ${left} after ${scanned} runs`;
            console.error(`stopping: ${stoppedEarly}`);
            break outer;
          }
        }
        scanned++;
        const pr = prNumberFromName(artifact.name);
        const run = {
          repo,
          pr,
          artifact_id: artifact.id,
          run_id: artifact.workflow_run?.id ?? null,
          run_head_sha: artifact.workflow_run?.head_sha ?? null,
          head_sha: null,
          artifact_created_at: artifact.created_at,
          base: null,
        };
        let json;
        try {
          json = downloadJson(repo, artifact, cacheDir, tmp);
        } catch (e) {
          runs.push({ ...run, kept: false, skip_reason: `artifact_missing: ${e.message}` });
          continue;
        }
        run.base = json.base ?? null;
        run.raised = json.meta?.raised ?? 0;
        run.survived = json.meta?.survived ?? 0;
        run.critic = json.meta?.critic ?? null;
        run.refuter = json.meta?.refuter ?? null;
        if (!keepRun(json)) {
          runs.push({ ...run, kept: false, skip_reason: "raised == 0" });
          continue;
        }

        const prKey = `${repo}#${pr}`;
        let prData = prCache.get(prKey);
        if (!prData) {
          try {
            prData = fetchPr(repo, pr);
          } catch (e) {
            prData = { error: e.message };
          }
          prCache.set(prKey, prData);
        }

        let files = null;
        let range = "";
        let compareError = null;
        if (!prData.error) {
          run.head_sha = resolveRunHead(artifact, prData);
          run.final_head = prData.headRefOid;
          if (run.head_sha) {
            range = `${run.head_sha.slice(0, 7)}..${run.final_head.slice(0, 7)}`;
            const ck = `${repo}:${run.head_sha}...${run.final_head}`;
            if (!compareCache.has(ck)) {
              try {
                compareCache.set(ck, { files: fetchCompare(repo, run.head_sha, run.final_head) });
              } catch (e) {
                compareCache.set(ck, { error: e.message });
              }
            }
            ({ files = null, error: compareError = null } = compareCache.get(ck));
          } else {
            compareError = "no PR commit before the run";
          }
        }
        if (prData.error) run.error = prData.error;
        else if (compareError) run.error = `compare: ${compareError}`;

        const touchFor = (f) =>
          files
            ? { ...findTouch(files, f.file, f.line), range }
            : { fileTouched: null, hit: null, range };

        const created = Date.parse(artifact.created_at);
        const window = {
          notBefore: new Date(created - 60 * 60 * 1000).toISOString(),
          notAfter: new Date(created + 5 * 60 * 1000).toISOString(),
        };
        (json.findings ?? []).forEach((f, i) => {
          const thread = prData.threads ? matchThread(prData.threads, f, window) : null;
          const label = labelPosted({ touch: touchFor(f), thread });
          findings.push(findingRecord({ f, i, stratum: "posted", run, label }));
        });
        (json.dismissed ?? []).forEach((f, i) => {
          const label = labelDismissed({ touch: touchFor(f) });
          findings.push({ ...findingRecord({ f, i, stratum: "dismissed", run, label }), needs_hand_label: true });
        });
        run.posted = (json.findings ?? []).length;
        run.dismissed = (json.dismissed ?? []).length;
        runs.push(run);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const corpus = {
    generated_at: new Date().toISOString(),
    params: {
      repos: args.repos,
      since: args.since,
      max_per_repo: args.maxPerRepo,
      line_window: LINE_WINDOW,
      thread_line_slack: THREAD_LINE_SLACK,
      reject_regex: REJECT_RE.source,
      stopped_early: stoppedEarly,
    },
    runs,
    findings,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(corpus, null, 2));

  const s = summarize({ ...corpus, scanned });
  console.error(`wrote ${outPath} (${apiCalls} gh calls)`);
  console.error(`runs scanned: ${s.runs_scanned}, runs kept: ${s.runs_kept}`);
  for (const [name, c] of Object.entries(s.strata)) {
    console.error(
      `${name}: ${c.total} finding(s): acted_on ${c.acted_on}, rejected ${c.rejected}, unlabelled ${c.unlabelled}` +
        ` (labelled ${c.labelled} from ${c.labelled_prs} PRs)`,
    );
  }
  const errs = runs.filter((r) => r.error || (r.kept === false && r.skip_reason !== "raised == 0"));
  if (errs.length) console.error(`runs with errors: ${errs.length}`);
  return stoppedEarly ? 4 : 0;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`ab-collect: ${err.message}`);
      process.exit(1);
    },
  );
}
