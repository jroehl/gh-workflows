# Refuter A/B corpus

The refuter A/B test (PLAN.md, Step 2) scores candidate refuters against findings
whose truth is known from what people did with them. `bin/ab-collect.mjs` builds that
labelled corpus from past `pr-critic-<n>` workflow artifacts.

## The corpus never lives in this repo

This repo is public. The corpus quotes code from private repos and describes their
bugs, some of them security bugs. So it is written to
`~/dev/homelab-private-data/critic-ab/corpus.json`, outside any repo, and only
aggregate numbers are ever committed here. Two guards back that up:

- The collector refuses an `--out` (or `--cache-dir`) path inside this git worktree,
  after resolving symlinks and `..`.
- `.gitignore` ignores `ab/corpus*.json` and `ab/raw/` in case a copy lands here anyway.

## Running it

```bash
mkdir -p ~/dev/homelab-private-data/critic-ab
node bin/ab-collect.mjs \
  --out ~/dev/homelab-private-data/critic-ab/corpus.json \
  --cache-dir ~/dev/homelab-private-data/critic-ab/raw
```

It needs `gh` logged in with read access to the repos and `unzip` on PATH; there are no
npm dependencies. It refuses to start with fewer than 1000 core API requests left and
stops early (exit 4, corpus still written) if a re-check falls below that.

| Flag | Default |
|------|---------|
| `--repo <name\|owner/name>` (repeatable) | homelab, meal-planner, simple-frame, Dalbi under HINTERLAND-software |
| `--since YYYY-MM-DD` | 2026-09-01 |
| `--max-per-repo N` | 150, oldest first, because the oldest expire first (90-day retention) |
| `--cache-dir <dir>` | none; keeps each `pr-critic.json` so a rerun downloads nothing again |

The summary on stderr gives runs scanned, runs kept and findings per stratum per label.

## What it collects

It starts from artifacts, not from bot reviews, so runs where the refuter dismissed
every finding (no review was posted) are in too. Runs with `meta.raised == 0` are
skipped. Per run it records the artifact id, the workflow run id, the PR number, the
JSON's `base` and the PR head at the time of the run. A `/critic` comment run carries
the default branch as its head, so for those the head is the newest PR commit made
before the artifact.

Each finding goes into one of two strata:

- **posted**: entries of `findings`, the ones the production refuter confirmed and the
  bot posted.
- **dismissed**: entries of `dismissed`, the ones it refuted or left unproven. They carry
  `needs_hand_label: true`, because the commit heuristic is the only automatic signal
  they have and 20 of them get labelled by hand.

## Labels

**acted_on**: a commit after the review changed the cited file within ±10 lines of the
cited line. Read from the compare patch between the run's head and the PR's final head:
removed lines count at their own line, added lines at the line they were inserted before,
and context lines do not count. A renamed file matches on its old path. A finding with no
line, or a file whose patch GitHub omits, gets no line match.

**rejected** (posted stratum only): the critic's review thread for the finding (bot
thread on the same path, line or original line within ±2, opened inside the run's time
window) has a non-bot reply matching

```
/false positive|not a bug|not applicable|n\/a|wrong|incorrect|by design|won'?t fix|intended|stimmt nicht|kein fehler|falsch/i
```

**unlabelled**: neither. A finding with both a rejecting reply and a nearby change is
also left unlabelled, with `conflict:` in its evidence, rather than guessed at. So is a
thread that was resolved while the file stayed unchanged: until 2026-11-27 that counted
as `rejected`, but a fix made in another file closes a thread the same way. It keeps
`thread resolved, file unchanged` as its evidence.

**Hand labels**: `hand_label` (`real` or `not_real`), with `hand_label_by` and
`hand_label_reason`, sits beside `label` on 20 dismissed findings. The A/B harness
treats `acted_on` and `real` as real, `rejected` and `not_real` as not real.

Unlabelled findings are dropped from scoring. `label_evidence` holds the compare range
and hunk, or the reply excerpt (at most 200 characters).
