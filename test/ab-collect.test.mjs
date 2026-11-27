import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectArtifacts,
  keepRun,
  prNumberFromName,
  changedOldLines,
  findTouch,
  rejectionIn,
  matchThread,
  labelPosted,
  labelDismissed,
  refuseInsideWorktree,
  resolveRunHead,
  summarize,
} from "../bin/ab-collect.mjs";

const art = (id, name, created, extra = {}) => ({
  id,
  name,
  created_at: created,
  expired: false,
  workflow_run: { id: id * 10, head_sha: `sha${id}`, head_branch: "feat/x" },
  ...extra,
});

test("selectArtifacts keeps live pr-critic artifacts since the cutoff, oldest first, capped", () => {
  const list = [
    art(1, "pr-critic-10", "2026-10-05T00:00:00Z"),
    art(2, "pr-critic-11", "2026-09-02T00:00:00Z"),
    art(3, "pr-critic-12", "2026-08-30T00:00:00Z"), // before --since
    art(4, "pr-critic-13", "2026-09-10T00:00:00Z", { expired: true }),
    art(5, "coverage-14", "2026-09-11T00:00:00Z"),
    art(6, "pr-critic-", "2026-09-12T00:00:00Z"), // no PR number
    art(7, "pr-critic-15", "2026-09-20T00:00:00Z"),
  ];
  const picked = selectArtifacts(list, { since: "2026-09-01", maxPerRepo: 2 });
  assert.deepEqual(
    picked.map((a) => a.id),
    [2, 7],
  );
  const all = selectArtifacts(list, { since: "2026-09-01", maxPerRepo: 150 });
  assert.deepEqual(
    all.map((a) => a.id),
    [2, 7, 1],
  );
});

test("prNumberFromName reads the PR number and rejects anything else", () => {
  assert.equal(prNumberFromName("pr-critic-344"), 344);
  assert.equal(prNumberFromName("pr-critic-"), null);
  assert.equal(prNumberFromName("pr-critic-12a"), null);
  assert.equal(prNumberFromName("other-12"), null);
});

test("keepRun skips raised==0 and keeps dismissal-only runs", () => {
  assert.equal(keepRun({ meta: { raised: 0, survived: 0 } }), false);
  assert.equal(keepRun({ meta: { empty: true } }), false);
  assert.equal(keepRun({}), false);
  assert.equal(keepRun(null), false);
  assert.equal(keepRun({ meta: { raised: 3, survived: 0 } }), true);
  assert.equal(keepRun({ meta: { raised: 3, survived: 2 } }), true);
});

const PATCH = [
  "@@ -40,7 +40,8 @@ function a() {",
  " ctx40",
  " ctx41",
  " ctx42",
  "-old43",
  "+new43",
  "+new43b",
  " ctx44",
  " ctx45",
  " ctx46",
  "@@ -100,3 +101,4 @@",
  " ctx100",
  "+inserted after 100",
  " ctx101",
  " ctx102",
].join("\n");

test("changedOldLines places removals and insertions on the old side, ignoring context", () => {
  const changes = changedOldLines(PATCH);
  assert.deepEqual(
    changes.map((c) => c.line),
    [43, 44, 44, 101],
  );
  assert.equal(changes[0].header, "@@ -40,7 +40,8 @@");
});

test("findTouch: a change within ±10 lines counts, 11 lines away does not", () => {
  const files = [{ filename: "src/a.js", patch: PATCH }];
  assert.ok(findTouch(files, "src/a.js", 53).hit, "43 is exactly 10 below 53");
  assert.equal(findTouch(files, "src/a.js", 55).hit, null, "44 is 11 below 55");
  assert.ok(findTouch(files, "src/a.js", 33).hit, "43 is exactly 10 above 33");
  assert.equal(findTouch(files, "src/a.js", 32).hit, null, "43 is 11 above 32");
  assert.ok(findTouch(files, "src/a.js", 111).hit, "insertion point 101");
  assert.equal(findTouch(files, "src/a.js", 75).hit, null);
  assert.equal(findTouch(files, "src/a.js", 75).fileTouched, true);
});

test("findTouch: other files, renames, missing patch and null line", () => {
  const files = [
    { filename: "src/new.js", previous_filename: "src/old.js", patch: PATCH },
    { filename: "big.lock" },
  ];
  assert.deepEqual(findTouch(files, "src/b.js", 43), { fileTouched: false, hit: null });
  assert.ok(findTouch(files, "src/old.js", 43).hit, "matches the pre-rename path");
  const big = findTouch(files, "big.lock", 5);
  assert.equal(big.fileTouched, true);
  assert.equal(big.hit, null, "no patch means no line evidence");
  assert.equal(findTouch(files, "src/new.js", null).hit, null, "no cited line, no line match");
  assert.equal(findTouch(files, "src/new.js", null).fileTouched, true);
});

test("rejectionIn matches the reply phrases, English and German, case-insensitive", () => {
  for (const body of [
    "This is a false positive",
    "Not a bug: the guard runs first",
    "N/A here",
    "That's wrong, the cache is per request",
    "Incorrect.",
    "By design",
    "Wont fix",
    "won't fix",
    "intended behaviour",
    "Stimmt nicht, das läuft vorher",
    "Kein Fehler",
    "Das ist FALSCH",
  ]) {
    assert.ok(rejectionIn(body), body);
  }
  for (const body of ["Fixed in 1a2b3c", "Good catch, done", "addressed"]) {
    assert.equal(rejectionIn(body), null, body);
  }
});

const thread = (over) => ({
  path: "src/a.js",
  line: 50,
  originalLine: 50,
  isResolved: false,
  comments: [
    {
      author: "github-actions",
      body: "🟠 **high** — the cache leaks",
      createdAt: "2026-10-01T10:00:00Z",
    },
  ],
  ...over,
});

test("matchThread picks the bot thread on the same path within ±2 lines and the run's time window", () => {
  const finding = { file: "src/a.js", line: 51, claim: "the cache leaks" };
  const window = { notBefore: "2026-10-01T09:00:00Z", notAfter: "2026-10-01T10:05:00Z" };
  assert.ok(matchThread([thread()], finding, window));
  assert.equal(matchThread([thread({ line: 54, originalLine: 54 })], finding, window), null);
  assert.ok(matchThread([thread({ line: null, originalLine: 49 })], finding, window), "outdated thread");
  assert.equal(matchThread([thread({ path: "src/b.js" })], finding, window), null);
  const human = thread();
  human.comments[0].author = "jroehl";
  assert.equal(matchThread([human], finding, window), null, "not a bot thread");
  const later = thread();
  later.comments[0].createdAt = "2026-10-02T10:00:00Z";
  assert.equal(matchThread([later], finding, window), null, "a later run's thread");
  // Two candidates: the one quoting the claim wins over the nearer one.
  const near = thread({ line: 51, originalLine: 51 });
  near.comments[0].body = "🟡 **low** — something else";
  const quoting = thread({ line: 53, originalLine: 53 });
  assert.equal(matchThread([near, quoting], finding, window), quoting);
});

const touchNone = { fileTouched: false, hit: null };
const touchFile = { fileTouched: true, hit: null };
const touchHit = { fileTouched: true, hit: { header: "@@ -40,7 +40,8 @@", line: 43 }, range: "aaa..bbb" };

test("labelPosted: acted_on, rejected by reply, resolve-without-change stays unlabelled", () => {
  assert.equal(labelPosted({ touch: touchHit, thread: thread() }).label, "acted_on");
  assert.match(labelPosted({ touch: touchHit, thread: thread() }).evidence, /aaa\.\.bbb/);

  const replied = thread();
  replied.comments.push({ author: "jroehl", body: "False positive, the lock is held", createdAt: "x" });
  const r = labelPosted({ touch: touchNone, thread: replied });
  assert.equal(r.label, "rejected");
  assert.match(r.evidence, /False positive/);

  const botReply = thread();
  botReply.comments.push({ author: "coderabbitai", body: "this is wrong", createdAt: "x", isBot: true });
  assert.equal(labelPosted({ touch: touchNone, thread: botReply }).label, "unlabelled", "bot replies do not count");

  // Demoted 2026-11-27: a thread resolved with the file untouched is also how a fix
  // made elsewhere gets closed, so it is evidence, not a rejection.
  const resolvedUnchanged = labelPosted({ touch: touchNone, thread: thread({ isResolved: true }) });
  assert.equal(resolvedUnchanged.label, "unlabelled");
  assert.match(resolvedUnchanged.evidence, /thread resolved, file unchanged/);
  assert.equal(
    labelPosted({ touch: touchFile, thread: thread({ isResolved: true }) }).label,
    "unlabelled",
    "resolved, but the file changed elsewhere: neither signal",
  );
  assert.equal(labelPosted({ touch: touchNone, thread: thread() }).label, "unlabelled");
  assert.equal(labelPosted({ touch: touchNone, thread: null }).label, "unlabelled");
  assert.equal(labelPosted({ touch: touchHit, thread: null }).label, "acted_on", "orphan finding still gets the commit signal");

  const long = thread();
  long.comments.push({ author: "jroehl", body: `wrong ${"x".repeat(400)}`, createdAt: "x" });
  assert.ok(labelPosted({ touch: touchNone, thread: long }).evidence.length <= 200);
});

test("labelPosted: an explicit rejection and a nearby change conflict and stay unlabelled", () => {
  const replied = thread();
  replied.comments.push({ author: "jroehl", body: "not a bug", createdAt: "x" });
  const r = labelPosted({ touch: touchHit, thread: replied });
  assert.equal(r.label, "unlabelled");
  assert.match(r.evidence, /conflict/);
});

test("labelDismissed uses the commit heuristic only", () => {
  assert.equal(labelDismissed({ touch: touchHit }).label, "acted_on");
  assert.equal(labelDismissed({ touch: touchFile }).label, "unlabelled");
  assert.equal(labelDismissed({ touch: touchNone }).label, "unlabelled");
});

test("refuseInsideWorktree refuses paths inside the worktree, symlinks and .. included", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "abc-")));
  try {
    const repo = join(root, "repo");
    const outside = join(root, "data");
    mkdirSync(join(repo, "ab"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(join(repo, "ab"), join(root, "link"));
    assert.throws(() => refuseInsideWorktree(join(repo, "ab", "corpus.json"), repo), /inside the git worktree/);
    assert.throws(() => refuseInsideWorktree(join(repo, "new", "deeper", "c.json"), repo), /inside/);
    assert.throws(() => refuseInsideWorktree(join(outside, "..", "repo", "c.json"), repo), /inside/);
    assert.throws(() => refuseInsideWorktree(join(root, "link", "c.json"), repo), /inside/, "symlink into the repo");
    assert.throws(() => refuseInsideWorktree(repo, repo), /inside/);
    assert.equal(refuseInsideWorktree(join(outside, "c.json"), repo), join(outside, "c.json"));
    assert.equal(
      refuseInsideWorktree(join(root, "repo-sibling", "c.json"), repo),
      join(root, "repo-sibling", "c.json"),
      "a sibling sharing the prefix is outside",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRunHead: PR-branch runs use their head_sha, comment runs map to the PR commit at the time", () => {
  const pr = {
    headRefName: "feat/x",
    commits: [
      { oid: "c1", committedDate: "2026-10-01T08:00:00Z" },
      { oid: "c2", committedDate: "2026-10-01T09:00:00Z" },
      { oid: "c3", committedDate: "2026-10-01T11:00:00Z" },
    ],
  };
  assert.equal(
    resolveRunHead({ workflow_run: { head_sha: "cX", head_branch: "feat/x" }, created_at: "2026-10-01T10:00:00Z" }, pr),
    "cX",
  );
  assert.equal(
    resolveRunHead({ workflow_run: { head_sha: "main1", head_branch: "main" }, created_at: "2026-10-01T10:00:00Z" }, pr),
    "c2",
  );
  assert.equal(
    resolveRunHead({ workflow_run: { head_sha: "main1", head_branch: "main" }, created_at: "2026-09-01T00:00:00Z" }, pr),
    null,
  );
});

test("summarize counts runs and findings per stratum per label", () => {
  const s = summarize({
    runs: [{}, {}],
    scanned: 5,
    findings: [
      { stratum: "posted", label: "acted_on", pr: 1, repo: "a" },
      { stratum: "posted", label: "rejected", pr: 2, repo: "a" },
      { stratum: "posted", label: "unlabelled", pr: 2, repo: "a" },
      { stratum: "dismissed", label: "unlabelled", pr: 3, repo: "a" },
    ],
  });
  assert.equal(s.runs_scanned, 5);
  assert.equal(s.runs_kept, 2);
  assert.deepEqual(s.strata.posted, { acted_on: 1, rejected: 1, unlabelled: 1, total: 3, labelled: 2, labelled_prs: 2 });
  assert.deepEqual(s.strata.dismissed, { acted_on: 0, rejected: 0, unlabelled: 1, total: 1, labelled: 0, labelled_prs: 0 });
});
