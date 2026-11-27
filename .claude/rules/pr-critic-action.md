---
paths:
  - "action.yml"
  - ".github/workflows/**"
---

# pr-critic action contract

Current state (2026-11-27). The composite action in `action.yml` is the only thing
consumers touch, and the ways it can go wrong all look like success.

## Run the action's own checkout, never an install from a ref

The `Review` step in `action.yml` runs `node "$GITHUB_ACTION_PATH/bin/pr-critic.mjs"`. It used to run
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

The end of the `Review` step maps the CLI's exit code:

| Exit | Cause | Check | On the PR |
|---|---|---|---|
| 0 | a review was posted, or the diff was skipped (`meta.skipped`) | green | the review; a skipped diff posts nothing and removes a stale notice |
| 1 | every link of a chain failed (outage, quota, unusable answer, no link fits the cost cap), or posting the review failed | green, `::warning::` | "no review ran" notice naming the stage and the error; after a failed post it points at the `pr-critic.json` artifact, which holds the findings |
| 3 | a config error (model off the allowlist, family rule, empty chain, bad `--max-cost`), or a key rejected on the last link of its chain (OpenRouter credit exhausted, a revoked key) | red, `::error::` | "no review ran" notice; stage `config` for a config error |

Exit 3 will not fix itself, so it fails the check. Everything else is an outage or a budget
decision, which must not turn someone's pull request red.

The cost cap (`--max-cost`, input `max-cost`, default $0.50 in the CLI) is checked before
every paid call. A link that cannot fit the remaining budget is skipped as `cost_cap` before
any request and the next, possibly cheaper, link is tried. Only when no link fits does the
run stop, post the notice with `cost cap $x reached after <stage>`, and exit 1. A call that
was sent but failed without a usage report is debited its reserved worst case. A
rejected credit key that is not the last link fails over instead and leaves a
`::warning::<transport> credit key rejected` plus a line in the review footer.

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

`test/action-args.test.mjs` runs the `Review` step's shell with a fake `node` and checks
what reaches argv, so an input threaded in three places fails there before it fails in CI.

The inputs and how each is passed:

| Input | Step env | Into the CLI |
|---|---|---|
| `openrouter-api-key`, `openai-api-key`, `anthropic-api-key`, `github-token` | `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` | env only, never argv: argv shows in the process list of a shared runner. An empty key drops its links |
| `critic-model`, `critic-fallback-model`, `refuter-model` | `CRITIC`, `CRITIC_FALLBACK`, `REFUTER` | the flag only when non-empty; empty leaves `src/models.json` in charge |
| `max-cost` | `MAX_COST` | `--max-cost` only when non-empty |
| `no-skip` | `NO_SKIP` | `--no-skip` when `"true"`; a caller with a `/critic` trigger passes `${{ github.event_name == 'issue_comment' }}` |
| `post`, `pr`, `base` | `POST`, `PR`, `BASE` | `--post` when `"true"`; `--pr`; `--base`, defaulting to `origin/<base ref>` |

There is deliberately no input for `--allow-any-model`, so CI cannot leave the allowlist.
`critic-fallback-model` can no longer be set to `""` to disable the fallback from the
action: empty now means "use the default", and the family rule requires a second family
anyway.
