import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTROL,
  Ledger,
  callOne,
  constConfirmedAnswer,
  findingKey,
  gate,
  orderFindings,
  outputAllowance,
  parseArgs,
  percentile,
  reservationFor,
  sampleRuns,
  scoreCalls,
  truthOf,
} from "../bin/pr-critic-ab.mjs";
import { validateRefuteAnswer } from "../src/refute.mjs";

const f = (over = {}) => ({
  artifact_id: 1,
  stratum: "posted",
  label: "unlabelled",
  file: "a.js",
  line: 1,
  claim: "c",
  ...over,
});

test("truthOf: posted acted_on/rejected and hand labels count; a dismissed commit-heuristic label does not", () => {
  assert.equal(truthOf(f({ label: "acted_on" })), "real");
  assert.equal(truthOf(f({ label: "rejected" })), "not_real");
  assert.equal(truthOf(f({ stratum: "dismissed", hand_label: "real" })), "real");
  assert.equal(truthOf(f({ stratum: "dismissed", hand_label: "not_real" })), "not_real");
  assert.equal(truthOf(f({ stratum: "dismissed", label: "acted_on", hand_label: "not_real" })), "not_real", "a hand label wins");
  assert.equal(truthOf(f({ stratum: "dismissed", label: "acted_on" })), null, "a nearby edit is not proof of a fix");
  assert.equal(truthOf(f({ stratum: "dismissed", label: "rejected" })), null, "only a hand label decides a dismissed finding");
  assert.equal(truthOf(f()), null);
});

function corpusWith() {
  const runs = [];
  const findings = [];
  const add = (id, list) => {
    runs.push({ artifact_id: id, repo: "o/r", pr: id });
    list.forEach((x) => findings.push(f({ artifact_id: id, ...x })));
  };
  add(1, [{ label: "acted_on" }]); // posted label
  add(2, [{ label: "rejected" }, { stratum: "dismissed" }]); // posted label
  add(3, [{ stratum: "dismissed", hand_label: "real" }]); // hand label
  add(4, [{ stratum: "posted" }]); // nothing labelled: never sampled
  for (let id = 100; id < 140; id++) add(id, [{ stratum: "dismissed", label: "acted_on" }]); // heuristic only
  add(200, [{ stratum: "dismissed", label: "acted_on" }, { label: "acted_on" }]); // has a posted label too
  runs.push({ artifact_id: 300, kept: false });
  return { runs, findings };
}

test("sampleRuns: every run with a scored finding and no other, in a seeded order", () => {
  const c = corpusWith();
  const a = sampleRuns(c, { seed: 20261127 });
  const ids = a.runs.map((r) => r.artifact_id);
  assert.deepEqual([...ids].sort((x, y) => x - y), [1, 2, 3, 200], "no unlabelled, heuristic-only or dropped run");
  assert.deepEqual(a.counts, { scored: 4, heuristic_only: 40, total: 4 });

  const b = sampleRuns(c, { seed: 20261127 });
  assert.deepEqual(b.runs.map((r) => r.artifact_id), ids, "same seed, same order");
});

test("orderFindings: the critic's raised order when known, else the order given; unmatched ones go last", () => {
  const p0 = f({ claim: "p0", line: 1 });
  const d0 = f({ stratum: "dismissed", claim: "d0", line: 2 });
  const d1 = f({ stratum: "dismissed", claim: "d1", line: null });
  const raised = [
    { file: "a.js", line: 2, claim: "d0" },
    { file: "a.js", line: 1, claim: "p0" },
  ];
  const { findings, exact } = orderFindings([p0, d0, d1], raised);
  assert.deepEqual(findings.map((x) => x.claim), ["d0", "p0", "d1"]);
  assert.equal(exact, false, "d1 was not in the raised list");

  const full = orderFindings([p0, d0], raised);
  assert.equal(full.exact, true);

  const none = orderFindings([p0, d0, d1], null);
  assert.deepEqual(none.findings.map((x) => x.claim), ["p0", "d0", "d1"]);
  assert.equal(none.exact, false);
  assert.equal(findingKey(d1), "a.js:?:d1");
});

test("constConfirmedAnswer: valid refuter JSON with CONFIRMED for every index", () => {
  const v = validateRefuteAnswer(JSON.parse(constConfirmedAnswer(3)), 3);
  assert.deepEqual(v.map((x) => x.verdict), ["CONFIRMED", "CONFIRMED", "CONFIRMED"]);
  assert.equal(CONTROL, "const-confirmed");
});

const call = (truths, verdicts, extra = {}) => ({
  findings: truths.map(([truth, stratum]) => ({ truth, stratum })),
  verdicts,
  cost: 0.01,
  latency_ms: 1000,
  ...extra,
});

test("scoreCalls: keep = CONFIRMED / real, kill = (REFUTED + UNPROVEN) / not-real, unlabelled ignored", () => {
  const s = scoreCalls([
    call(
      [
        ["real", "posted"],
        ["real", "posted"],
        ["not_real", "posted"],
        [null, "posted"],
      ],
      ["CONFIRMED", "UNPROVEN", "UNPROVEN", "REFUTED"],
    ),
    call(
      [
        ["real", "dismissed"],
        ["not_real", "dismissed"],
        ["not_real", "dismissed"],
      ],
      ["CONFIRMED", "CONFIRMED", "REFUTED"],
      { cost: 0.03, latency_ms: 3000 },
    ),
  ]);
  assert.deepEqual(s.posted, { real: 2, kept: 1, keep: 0.5, not_real: 1, killed: 1, kill: 1 });
  assert.deepEqual(s.dismissed, { real: 1, kept: 1, keep: 1, not_real: 2, killed: 1, kill: 0.5 });
  assert.deepEqual(s.overall, { real: 3, kept: 2, keep: 2 / 3, not_real: 3, killed: 2, kill: 2 / 3 });
  assert.equal(s.calls, 2);
  assert.equal(s.shape_failures, 0);
  assert.ok(Math.abs(s.cost - 0.04) < 1e-12);
  assert.equal(s.p50_ms, 1000);
  assert.equal(s.p90_ms, 3000);
});

test("scoreCalls: a shape failure is a miss for every finding in that call, both ways", () => {
  const s = scoreCalls([
    call(
      [
        ["real", "posted"],
        ["not_real", "posted"],
      ],
      null,
      { failure: "shape" },
    ),
    call([["real", "posted"]], ["CONFIRMED"]),
  ]);
  assert.equal(s.shape_failures, 1);
  assert.deepEqual(s.posted, { real: 2, kept: 1, keep: 0.5, not_real: 1, killed: 0, kill: 0 });
});

test("percentile: nearest rank", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 0.9), 9);
});

const sc = (keep, kill) => ({ overall: { keep, kill } });

test("gate: keep >= baseline and kill >= baseline - 5 points, in every run", () => {
  const scores = {
    base: [sc(0.6, 0.5), sc(0.62, 0.48)],
    good: [sc(0.6, 0.46), sc(0.7, 0.44)],
    lowkeep: [sc(0.59, 0.9), sc(0.9, 0.9)],
    lowkill: [sc(0.9, 0.44), sc(0.9, 0.9)],
    [CONTROL]: [sc(1, 0), sc(1, 0)],
  };
  const g = gate(scores, { baseline: "base" });
  assert.equal(g.verdicts.good.pass, true);
  assert.equal(g.verdicts.lowkeep.pass, false);
  assert.equal(g.verdicts.lowkill.pass, false, "fails in run 1 even though run 2 passes");
  assert.equal(g.verdicts[CONTROL].pass, false);
  assert.equal(g.verdicts.base.baseline, true);
  assert.equal(g.broken, false);
});

test("gate: with three runs, failing only the third fails the candidate", () => {
  const g = gate(
    {
      base: [sc(0.5, 0.5), sc(0.5, 0.5), sc(0.5, 0.5)],
      late: [sc(0.6, 0.6), sc(0.6, 0.6), sc(0.4, 0.6)],
      steady: [sc(0.6, 0.6), sc(0.6, 0.6), sc(0.6, 0.6)],
      [CONTROL]: [sc(1, 0), sc(1, 0), sc(1, 0)],
    },
    { baseline: "base" },
  );
  assert.equal(g.verdicts.late.pass, false);
  assert.equal(g.verdicts.steady.pass, true);
  assert.equal(g.verdicts.steady.runs.length, 3);
});

test("gate: a control that passes breaks the gate", () => {
  const g = gate({ base: [sc(0.9, 0.03), sc(0.9, 0.04)], [CONTROL]: [sc(1, 0), sc(1, 0)] }, { baseline: "base" });
  assert.equal(g.verdicts[CONTROL].pass, true);
  assert.equal(g.broken, true);
});

test("gate: a missing run fails the candidate rather than passing on the runs it has", () => {
  const g = gate({ base: [sc(0.5, 0.5), sc(0.5, 0.5)], half: [sc(0.9, 0.9)], [CONTROL]: [sc(1, 0), sc(1, 0)] }, { baseline: "base" });
  assert.equal(g.verdicts.half.pass, false);
});

test("Ledger: reservations keep concurrent calls under the global budget", () => {
  const l = new Ledger(1.0, 0.4);
  const a = l.reserve();
  const b = l.reserve();
  const c = l.reserve();
  assert.equal(a, 0.4);
  assert.equal(b, 0.4);
  assert.ok(Math.abs(c - 0.2) < 1e-12, "the third gets what is left");
  assert.equal(l.reserve(), 0, "nothing left to reserve");
  l.settle(a, 0.1);
  assert.ok(Math.abs(l.spent - 0.1) < 1e-12);
  assert.ok(Math.abs(l.reserve() - 0.3) < 1e-12, "the unspent part of a reservation comes back");
});

test("Ledger.acquire: waits out other calls' reservations, and stops only when the spend leaves less than one call", async () => {
  const l = new Ledger(1.0, 0.4);
  const a = await l.acquire();
  const b = await l.acquire();
  assert.equal(a, 0.4);
  assert.equal(b, 0.4);
  let c = null;
  const pc = l.acquire().then((x) => (c = x));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c, null, "only 0.2 is free while two calls are in flight, so the third waits");
  l.settle(a, 0.1);
  await pc;
  assert.equal(c, 0.4, "a full reservation once the first call settled");
  let d = null;
  const pd = l.acquire().then((x) => (d = x));
  l.settle(b, 0.4);
  l.settle(c, 0.4);
  await pd;
  assert.equal(d, 0, "0.1 left and nothing in flight: the budget is spent");
});

test("Ledger.acquire(want): a call reserves what it needs, not the per-call cap", async () => {
  const l = new Ledger(1.0, 0.4);
  assert.ok(Math.abs((await l.acquire(0.1)) - 0.1) < 1e-12);
  assert.equal(await l.acquire(0.9), 0.4, "never more than the cap");
  assert.ok(Math.abs(l.reserved - 0.5) < 1e-12);
});

test("reservationFor: prompt at the input rate plus the output allowance at the output rate, capped", () => {
  const entry = { in_usd_per_m: 2, out_usd_per_m: 10 };
  const user = "x".repeat(400_000); // 100k tokens
  const r = reservationFor({ entry, system: "", user, allowance: 8000, cap: 1 });
  assert.ok(Math.abs(r - (0.2 + 0.08)) < 1e-6);
  assert.equal(reservationFor({ entry, system: "", user, allowance: 8000, cap: 0.25 }), 0.25);
  assert.equal(reservationFor({ entry: {}, system: "", user, allowance: 8000, cap: 0.4 }), 0.4, "an unpriced model gets the cap");
});

test("outputAllowance: 8000 by default, more only for the reasoning refuters whose cached answers ran past it", () => {
  assert.equal(outputAllowance("anthropic/claude-haiku-5.5"), 8000);
  assert.equal(outputAllowance("anthropic/claude-sonnet-5.5"), 8000);
  for (const id of ["google/gemini-3.1-pro-preview", "google/gemini-4-carbon", "deepseek/deepseek-v4.1-flash"]) {
    assert.ok(outputAllowance(id) >= 8000 && outputAllowance(id) <= 32000, id);
  }
});

test("parseArgs: three runs at concurrency 3 by default", () => {
  const o = parseArgs([]);
  assert.equal(o.runs, 3);
  assert.equal(o.concurrency, 3);
  assert.equal(parseArgs(["--runs", "2"]).runs, 2);
});

// ---------------------------------------------------------------- callOne

const HAIKU = "anthropic/claude-haiku-5.5";
const plainFindings = [{ file: "a.js", line: 1, severity: "high", claim: "c", failure_scenario: "s" }];

function callSetup(over = {}) {
  const rawDir = mkdtempSync(join(tmpdir(), "ab-raw-"));
  const sleeps = [];
  const requests = [];
  const opts = {
    rawDir,
    maxCostCall: 0.4,
    offline: false,
    creditWaitMs: 60_000,
    creditRetries: 3,
    sleep: async (ms) => sleeps.push(ms),
    ...over,
  };
  const args = {
    cand: HAIKU,
    r: 1,
    run: { repo: "o/r", pr: 1, artifact_id: 9 },
    ctx: { context: { diff: "diff --git a/a.js b/a.js\n" } },
    findings: plainFindings,
    opts,
    ledger: new Ledger(5, 0.4),
    state: { stopped: null, index: 0 },
  };
  return { opts, args, sleeps, requests };
}

const okAnswer = (requests, behaviour = () => null) => async ({ budget, entry, system, user, stage }) => {
  const { maxTokens } = budget.plan({ entry, system, user, stage });
  requests.push({ maxTokens, reserved: budget.max });
  const err = behaviour(requests.length);
  if (err) throw err;
  budget.debit(stage, 0.001, false);
  return { text: constConfirmedAnswer(1), usage: { prompt_tokens: 10, completion_tokens: 20 }, cost: 0.001, model: HAIKU };
};

const credit402 = () => {
  const e = new Error("OpenRouter 402: {\"error\":{\"message\":\"This request would exceed your available credit\"}}");
  e.fatal = true;
  return e;
};

test("callOne: sizes max_tokens from the output allowance and reserves only that", async () => {
  const { args, requests } = callSetup();
  args.opts.complete = okAnswer(requests);
  const out = await callOne(args);
  assert.equal(out.status, "ok");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].maxTokens, 8000);
  assert.ok(requests[0].reserved < 0.01, `haiku's reservation is cents, not the cap: ${requests[0].reserved}`);
});

test("callOne: a cached answer costs nothing and makes no request", async () => {
  const first = callSetup();
  first.args.opts.complete = okAnswer(first.requests);
  await callOne(first.args);

  const again = callSetup({ rawDir: first.opts.rawDir });
  again.args.opts.complete = async () => {
    throw new Error("a cached call must not reach the network");
  };
  const out = await callOne(again.args);
  assert.equal(out.status, "ok");
  assert.equal(out.cached, true);
  assert.deepEqual(out.verdicts, ["CONFIRMED"]);
  assert.equal(again.args.ledger.spent, 0);
  assert.equal(again.args.ledger.reserved, 0);
});

test("callOne: a 402 waits 60 s and retries the same call, and succeeds once credit is back", async () => {
  const { args, requests, sleeps } = callSetup();
  args.opts.complete = okAnswer(requests, (n) => (n <= 2 ? credit402() : null));
  const out = await callOne(args);
  assert.equal(out.status, "ok");
  assert.equal(requests.length, 3);
  assert.deepEqual(sleeps, [60_000, 60_000]);
  assert.equal(args.state.stopped, null);
  assert.ok(Math.abs(args.ledger.reserved) < 1e-12, "no reservation is left behind");
});

test("callOne: after 3 retries on 402 it stops cleanly and says why", async () => {
  const { args, requests, sleeps } = callSetup();
  args.opts.complete = okAnswer(requests, () => credit402());
  const out = await callOne(args);
  assert.equal(out.status, "not_called");
  assert.equal(requests.length, 4, "the first try plus 3 retries");
  assert.deepEqual(sleeps, [60_000, 60_000, 60_000]);
  assert.match(args.state.stopped.reason, /OpenRouter 402.*credit.*3 retries/);
  assert.ok(!existsSync(join(args.opts.rawDir, "anthropic__claude-haiku-5.5", "1", "r-1-9.json")), "a credit stop is not cached");
});

test("callOne: a 401 stops at once, without waiting", async () => {
  const { args, requests, sleeps } = callSetup();
  args.opts.complete = okAnswer(requests, () => Object.assign(new Error("OpenRouter 401: no auth"), { fatal: true }));
  const out = await callOne(args);
  assert.equal(out.status, "not_called");
  assert.equal(requests.length, 1);
  assert.deepEqual(sleeps, []);
  assert.match(args.state.stopped.reason, /OpenRouter 401/);
});
