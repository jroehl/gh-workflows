---
paths:
  - "action.yml"
  - ".github/workflows/**"
---

# pr-critic action contract

Current state (2026-09-05). The composite action in `action.yml` is the only thing
consumers touch, and the ways it can go wrong all look like success.

## Run the action's own checkout, never an install from a ref

`action.yml:104` runs `node "$GITHUB_ACTION_PATH/bin/pr-critic.mjs"`. It used to run
`npx --yes "github:jroehl/gh-workflows#${{ github.action_ref || 'main' }}"`, which took
`action.yml` from the calling ref and the CLI from whatever that ref resolved to. Under
`uses: ./` there is no `action_ref` at all, so it fell back to `main` and this repo
reviewed its own pull requests with the code on `main`: PR #5 added a flag, `main`'s
parser rejected it as unknown, the step announced a comment that did not exist, and the
check went green.

`GITHUB_ACTION_PATH` is this action at the ref that called it, so a pinned SHA now pins the
logic too. `package.json` has no `dependencies`, so there is nothing to install; keep it
that way, or this line needs an install step and the guarantee weakens.

## Node comes from nodejs.org, not actions/setup-node

The `Node` step uses a `node` >= 20 already on PATH, and otherwise downloads one pinned
release, checks it against `SHASUMS256.txt` and unpacks `bin/node` alone into
`$RUNNER_TEMP`. setup-node wrote ~0.46 GB per review into the tool cache of the self-hosted
runners, whose SSD is wearing out; this writes ~120 MB. It only works because the CLI has
no dependencies (see above). Bump `NODE_VERSION` by hand, and only to a version the
nodejs.org dist index lists, or every review fails at the download.

## Exit codes decide what the check says

`action.yml:107` onward. Exit 3 is a dead or exhausted OpenRouter key: no review will run
anywhere until someone acts, so it becomes `::error::` and fails the check. Any other
non-zero exit is a model-level failure and stays green with a `::warning::`, because an
outage must not turn someone's pull request red.

Green is therefore not evidence a review happened. The CLI posts a comment on the pull
request before it exits so the absence is visible without opening the log; that is the only
signal, so do not remove it without replacing it. A neutral check run was considered and
rejected: it needs `checks: write`, and every consumer grants only `contents: read` and
`pull-requests: write`, so it would 403 into the same silence.

## Adding an input

An input has to be threaded in four places or the run dies on an unknown flag: the `inputs:`
block, the step `env:`, the `args=(…)` array, and `bin/pr-critic.mjs` `parseArgs`. Because
consumers pin by SHA, a new flag also breaks nothing for them until they bump — but it does
break this repo's own `uses: ./` run for exactly one merge cycle if the CLI and `action.yml`
ever drift apart again.
