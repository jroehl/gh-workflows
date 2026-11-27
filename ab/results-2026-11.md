# Refuter A/B results, 2026-11

Run on 2026-11-27 by `bin/pr-critic-ab.mjs` (PLAN.md Step 2). Aggregates only: the corpus, the
raw answers and the per-finding scores are private and stay outside this repo.

## Input

- Corpus: 1350 findings from 573 kept runs (1769 artifacts scanned).
- Ground truth: real = posted acted_on (51) and dismissed hand-labelled real (2); not real = posted rejected (11) and dismissed hand-labelled not real (18). The 165 dismissed acted_on labels from the commit heuristic are not scored.
- Sample (seed 20261127): every run with a scored finding, 76 runs. 90 runs whose only label is a heuristic acted_on are left out.
- Unreproducible: 3 (base branch gone: 3).
- Scored: 73 runs, 3 runs per candidate. Posted: 49 real, 11 not real. Dismissed: 1 real, 18 not real. 102 unscored findings were replayed alongside them.
- Replay order: exact for 0 runs, corpus order (posted, then dismissed) for 73.
- Completed: all 73 reproducible runs were called for every candidate.
- Spend: $22.5272 across every call made, cached ones from earlier invocations included; this invocation spent $17.4322 of a $22.0000 budget (per call at most $0.4000).

Keep = CONFIRMED / real (UNPROVEN counts as not kept). Kill = (REFUTED + UNPROVEN) / not real.
A shape failure is a miss for every finding in that call.

## Gate

Pass: keep >= the baseline's and kill >= the baseline's minus 5 points, in all 3 runs. Baseline `google/gemini-3.1-pro-preview`, scored fresh on the same input.

| Candidate | Run 1 keep / kill | Run 2 keep / kill | Run 3 keep / kill | Verdict |
|---|---|---|---|---|
| `google/gemini-3.1-pro-preview` | 60.0% / 69.0% | 74.0% / 75.9% | 68.0% / 72.4% | baseline |
| `deepseek/deepseek-v4.1-flash` | 60.0% / 93.1% | 54.0% / 96.6% | 60.0% / 89.7% | fail |
| `anthropic/claude-haiku-5.5` | 76.0% / 75.9% | 78.0% / 79.3% | 74.0% / 82.8% | PASS |
| `const-confirmed` | 100.0% / 0.0% | 100.0% / 0.0% | 100.0% / 0.0% | fail |

The control fails the gate, as it must.

## Per candidate

### `google/gemini-3.1-pro-preview`

| Run | Stratum | Keep | Kill | Cost | p50 | p90 | Shape failures | Other failures |
|---|---|---|---|---|---|---|---|---|
| 1 | overall | 60.0% (30/50) | 69.0% (20/29) | $8.0612 | 40.7 s | 73.4 s | 0 | 0 |
| 1 | posted | 59.2% (29/49) | 45.5% (5/11) |  |  |  |  |  |
| 1 | dismissed | 100.0% (1/1) | 83.3% (15/18) |  |  |  |  |  |
| 2 | overall | 74.0% (37/50) | 75.9% (22/29) | $6.7586 | 29.1 s | 88.5 s | 0 | 0 |
| 2 | posted | 73.5% (36/49) | 63.6% (7/11) |  |  |  |  |  |
| 2 | dismissed | 100.0% (1/1) | 83.3% (15/18) |  |  |  |  |  |
| 3 | overall | 68.0% (34/50) | 72.4% (21/29) | $5.3834 | 34.6 s | 71.4 s | 2 | 0 |
| 3 | posted | 67.3% (33/49) | 36.4% (4/11) |  |  |  |  |  |
| 3 | dismissed | 100.0% (1/1) | 94.4% (17/18) |  |  |  |  |  |

### `deepseek/deepseek-v4.1-flash`

| Run | Stratum | Keep | Kill | Cost | p50 | p90 | Shape failures | Other failures |
|---|---|---|---|---|---|---|---|---|
| 1 | overall | 60.0% (30/50) | 93.1% (27/29) | $0.4982 | 38.3 s | 109.3 s | 2 | 0 |
| 1 | posted | 61.2% (30/49) | 81.8% (9/11) |  |  |  |  |  |
| 1 | dismissed | 0.0% (0/1) | 100.0% (18/18) |  |  |  |  |  |
| 2 | overall | 54.0% (27/50) | 96.6% (28/29) | $0.2634 | 38.3 s | 108.6 s | 1 | 0 |
| 2 | posted | 55.1% (27/49) | 90.9% (10/11) |  |  |  |  |  |
| 2 | dismissed | 0.0% (0/1) | 100.0% (18/18) |  |  |  |  |  |
| 3 | overall | 60.0% (30/50) | 89.7% (26/29) | $0.2380 | 35.9 s | 107.0 s | 2 | 0 |
| 3 | posted | 61.2% (30/49) | 72.7% (8/11) |  |  |  |  |  |
| 3 | dismissed | 0.0% (0/1) | 100.0% (18/18) |  |  |  |  |  |

### `anthropic/claude-haiku-5.5`

| Run | Stratum | Keep | Kill | Cost | p50 | p90 | Shape failures | Other failures |
|---|---|---|---|---|---|---|---|---|
| 1 | overall | 76.0% (38/50) | 75.9% (22/29) | $0.4417 | 6.9 s | 9.1 s | 0 | 0 |
| 1 | posted | 77.6% (38/49) | 45.5% (5/11) |  |  |  |  |  |
| 1 | dismissed | 0.0% (0/1) | 94.4% (17/18) |  |  |  |  |  |
| 2 | overall | 78.0% (39/50) | 79.3% (23/29) | $0.4410 | 6.8 s | 10.0 s | 0 | 0 |
| 2 | posted | 79.6% (39/49) | 54.5% (6/11) |  |  |  |  |  |
| 2 | dismissed | 0.0% (0/1) | 94.4% (17/18) |  |  |  |  |  |
| 3 | overall | 74.0% (37/50) | 82.8% (24/29) | $0.4417 | 6.4 s | 10.0 s | 0 | 0 |
| 3 | posted | 75.5% (37/49) | 63.6% (7/11) |  |  |  |  |  |
| 3 | dismissed | 0.0% (0/1) | 94.4% (17/18) |  |  |  |  |  |

### `const-confirmed`

| Run | Stratum | Keep | Kill | Cost | p50 | p90 | Shape failures | Other failures |
|---|---|---|---|---|---|---|---|---|
| 1 | overall | 100.0% (50/50) | 0.0% (0/29) | $0.0000 | n/a | n/a | 0 | 0 |
| 1 | posted | 100.0% (49/49) | 0.0% (0/11) |  |  |  |  |  |
| 1 | dismissed | 100.0% (1/1) | 0.0% (0/18) |  |  |  |  |  |
| 2 | overall | 100.0% (50/50) | 0.0% (0/29) | $0.0000 | n/a | n/a | 0 | 0 |
| 2 | posted | 100.0% (49/49) | 0.0% (0/11) |  |  |  |  |  |
| 2 | dismissed | 100.0% (1/1) | 0.0% (0/18) |  |  |  |  |  |
| 3 | overall | 100.0% (50/50) | 0.0% (0/29) | $0.0000 | n/a | n/a | 0 | 0 |
| 3 | posted | 100.0% (49/49) | 0.0% (0/11) |  |  |  |  |  |
| 3 | dismissed | 100.0% (1/1) | 0.0% (0/18) |  |  |  |  |  |

## Biases

- Replay order is approximate. Artifacts before v2 keep survivors and dismissals apart, so findings are replayed posted first, then dismissed. Every candidate sees the same order.
- The 20 hand labels on dismissed findings are by Codex (codex-cli 0.172.0), not Johann.
- The rule "thread resolved, file unchanged = rejected" was demoted on 2026-11-27; those findings are unlabelled now, which leaves the posted stratum with few not-real findings.
- The base is the base branch as it stood at the run's time (first parent before the artifact's timestamp), and the head is the PR head; for pull_request runs production diffed the merge commit, so the replayed diff can differ where the base moved during the run.
- Dismissed acted_on labels from the commit heuristic (a change within 10 lines later in the PR) are not scored: in the first run (2026-11-27) no candidate kept any of 17, and 18 of the 20 hand-labelled dismissed findings were not real. They are still replayed when they share a run with a scored finding.
- The dismissed stratum's truth rests on 20 hand labels, so its rates move a lot with one finding.
- Refuter verdicts are noisy run to run: in the first run the fresh baseline confirmed only 45-73% of the posted findings it had confirmed in production. That is why each candidate runs 3 times and must pass in every run.
- Runs 1 and 2 reuse the cached answers of the first run (2026-11-27), which was sized to the old $0.40 per-call cap; run 3 and every new call were sized to the prompt plus a per-model output allowance (8000 tokens, more for the three reasoning refuters). One cached deepseek answer spent the whole 32000-token ceiling on reasoning and is replayed as a shape failure.
