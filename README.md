# gh-workflows

Cross-model adversarial pull-request review that runs the same way in CI and on a
laptop.

## Why it is built this way

A model reviewing code from its own family is the weakest reviewer that change can
have. GPT-3.5 and GPT-4 repair other models' vulnerable code at 33-60% success and
"perform poorly when repairing self-produced code" ([arXiv 2408.10495]), LLM judges
score their own output higher in proportion to how well they recognise it
([NeurIPS 2024]), and intrinsic self-correction runs below break-even: GPT-3.5 fixed
7.6% of its wrong answers while breaking 8.8% of its right ones ([ICLR 2024]).

So the critic here is never the model that wrote the code, and the refuter is never
the critic's family. Ensembles across model families reach up to 83% above the best
single model, and two models are enough to get most of it ([arXiv 2510.21513]). The
same paper is why findings are unioned and each judged on its own: consensus voting
falls into a "popularity trap" where models trained on similar data agree on the same
wrong answer and vote out the minority-correct one.

Findings are then attacked rather than collected. Adversarial verification cuts false
positives by 88.6% for a 3.1% recall loss ([QASecClaw]), and false positives are the
thing that gets a review tool ignored.

The output is advisory. Agent-only-reviewed PRs merge at 45.2% against 68.4% for
human-reviewed ones ([arXiv 2604.03196]), so this never gates a merge.

## Use it

```bash
export OPENROUTER_API_KEY=...          # locally: mint openrouter
npx github:jroehl/gh-workflows --base origin/main
```

```
pr-critic --base <ref> [--pr <n> --repo <owner/name>] [options]

  --base <ref>            base to diff against (default: origin/HEAD, then main)
  --pr <n> --repo <o/r>   fetch the PR title and body as the stated intent
  --critic-model <id>     replaces the critic chain
  --critic-fallback-model <id>
                          used when the critic fails; default: the first OpenRouter
                          link of the default chain from another family
  --refuter-model <id>    replaces the refuter chain with this model, then the
                          default chain's last OpenRouter link
  --allow-any-model       accept IDs that are not in src/models.json
  --max-cost <usd>        stop before a call that could take the run past this
                          (default 0.5)
  --exclude <pathspec>    extra path to leave out of the diff (repeatable)
  --keep-unproven         keep findings the refuter could not settle
  --no-skip               review even a diff of only docs or generated files
  --post                  publish survivors as one GitHub review (needs GITHUB_TOKEN)
  --json <path>           also write the full result as JSON
```

`--help` prints the same list with the current default chains filled in.

Surviving findings go to stdout as JSON; progress goes to stderr. Findings the
refuter killed stay in the payload under `dismissed` with the reason, because a
finding that disappears without a reason is worse than one that was wrong.

## Chains, transports and who pays

Each role has an ordered chain of models in [`src/models.json`](src/models.json),
which is also the allowlist with each model's family and price. That file is the
only place the defaults live; `action.yml` and the CLI pass nothing unless a caller
sets a model explicitly. A model ID not on the list is refused before any call,
unless `--allow-any-model` is passed, which the action does not expose.

The prefix of a link picks how it is reached and who pays for it:

| Prefix | Transport | Needs | Paid by |
|---|---|---|---|
| `openai:<model>` | OpenAI API | `OPENAI_API_KEY` | the credit included with the ChatGPT plan |
| `anthropic:<model>` | Anthropic API | `ANTHROPIC_API_KEY` | the credit included with the Claude plan |
| `codex:<model>` | `codex exec`, local only | `CI` unset, a ChatGPT login | the ChatGPT subscription's allowance |
| `vendor/model` | OpenRouter | `OPENROUTER_API_KEY` | the OpenRouter key's owner |

A link whose credential is missing is dropped before the run starts, and the rest
is tried in order. Spent credit, a quota, a timeout or an unusable answer moves on to
the next link; `meta.chain` in the JSON lists every attempt and why it failed, and
`meta.cost.paid_by` names the transport that answered. A rejected credit key also
fails over, with a `::warning::` and a line in the review footer, so a dead key shows
up on the next pull request rather than as an OpenRouter bill. Only on the last link
does a rejected key stop the run.

So credit is spent first, then the subscription (locally), then OpenRouter. A review
on the credit path cost $0.002 on 2026-11-27; on OpenRouter alone it is a few cents.

`PR_CRITIC_PAYER=openrouter` keeps only the OpenRouter links. Set it when the
OpenRouter key belongs to a client, so their reviews never land on your OpenAI
credit or Codex account.

The family rules are checked on the chain as it will run, after the dropped links
are gone: the critic is never Anthropic, the critic chain has a second family for its
fallback, and no refuter link shares a family with any critic link. `openai:`,
`codex:` and `openai/` count as one family.

## The cost cap

`--max-cost` (default $0.50, the action's `max-cost` input) is checked before every
paid call against what is left. Each call's output allowance is cut so that the
answer cannot take the run past the cap at that model's output price; input is priced
up front from the prompt's size, so the cap bounds output cost while the input is
reserved before the call. A call that would not get 4,000 tokens is not made.

A run stopped by the cap posts the "no review ran" notice naming the stage, and the
check stays green. The total cost is in `meta.cost` and in the review footer, marked
"estimated" when a provider did not report it and the registry prices were used.

## What is not reviewed

A diff where every changed file is plain documentation or generated is not sent to a
model. It posts nothing, removes a stale "no review ran" notice, writes
`meta.skipped` with the reason, and exits 0. A file counts as:

- documentation when it is `*.md` (not `*.mdx`, which compiles to JS), outside any dot-directory (`.claude/`,
  `.github/`, `.cursor/`, ...) or `prompts/`, `skills/`, `agents/` or `instructions/`
  directory, and not an agent file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`,
  anything with "prompt" in its name). Those carry instructions for agents or for GitHub,
  so they are reviewed like code. Names match case-insensitively;
- generated when the base tree's `.gitattributes` marks it `linguist-generated`.
  The attributes are read from the merge base (`git check-attr --source`), never
  from the pull request's checkout, so a pull request cannot mark its own change
  generated. A change to any `.gitattributes` is always reviewed. Where
  `check-attr --source` fails (git older than 2.40), nothing counts as generated.

Lockfiles, snapshots, minified files and source maps are left out of the diff
anyway, so a change of only those has nothing to review either.

`--no-skip` (the action's `no-skip` input) reviews regardless. A `/critic` comment
passes it, because someone asked.

## When no review runs

A critic that answers with an empty string looks the same as a clean review, so a
failed run says so out loud. The fallback critic gets a turn first; if that fails
too, the run posts a comment on the pull request naming the models it called and
the error, and removes it again once a review lands. CI stays green, because a model
outage is not the author's problem to fix, except on exit 3: a configuration error,
or a key rejected on the last link of its chain, which will not fix itself and
fails the check.

## Choosing models

The only hard rule is that critic and refuter come from different families, and
neither is the family that wrote the code. Measured while building this: on a claim
that depended on code outside the diff, `gemini-3.1-flash-lite` confirmed it while
`gemini-3.1-pro-preview` correctly returned UNPROVEN. The refuter is the wrong place
to save money.

The critic chain spans two families and the refuter chain shares neither, so the
separation survives the run where every link of the first critic family fails.

The refuter is chosen by measurement, not by price. `anthropic/claude-haiku-5.5`
replaced `google/gemini-3.1-pro-preview` after it kept at least as many real findings
and killed at least as many false ones in three replays of past reviews; the numbers
are in [`ab/results-2026-11.md`](ab/results-2026-11.md). An Anthropic model may be the
refuter only while `src/models.json` sets `refuter_ok_anthropic` for it, and never the
critic.

`openai/gpt-5.1-codex` was the default until it reviewed nothing for a day. It is a
capable critic but an expensive one: on a 42k-character diff it spent 24k reasoning
tokens and 25 cents, against 724 tokens and 1.6 cents for `x-ai/grok-4.3`. Budget for
it if you pick it: the token ceiling is shared with reasoning, and a critic that runs
out of ceiling returns an empty string rather than an error.

[arXiv 2408.10495]: https://arxiv.org/abs/2408.10495
[NeurIPS 2024]: https://arxiv.org/abs/2404.13076
[ICLR 2024]: https://arxiv.org/abs/2310.01798
[arXiv 2510.21513]: https://arxiv.org/abs/2510.21513
[QASecClaw]: https://arxiv.org/html/2605.01885v1
[arXiv 2604.03196]: https://arxiv.org/html/2604.03196v1

## Use it from CI

The repo root is a composite action, and it is public, so any owner can call it; each
supplies its own `OPENROUTER_API_KEY`. The two credit keys are optional: an unset
secret arrives empty, that link is dropped, and the run goes to OpenRouter.

```yaml
name: PR review
on:
  pull_request:
    types: [opened, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-22.04   # or a self-hosted label where you have runners
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # the diff is against the merge base
      - uses: jroehl/gh-workflows@<commit sha> # v2.0.0
        with:
          pr: ${{ github.event.pull_request.number }}
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # With a /critic comment trigger, so an explicit request is never skipped:
          no-skip: ${{ github.event_name == 'issue_comment' }}
```

Pin the commit SHA of a release tag, with the tag in a trailing comment
(`@<sha> # v2.0.0`). Dependabot and Renovate both read that comment and open the bump
when a new tag is cut, which a branch-pinned SHA never gets. `v2` is a moving tag for
the latest 2.x release; pin the exact one.

The other inputs are `base`, `critic-model`, `critic-fallback-model`,
`refuter-model`, `max-cost` and `post`; see `action.yml`. Leave the model inputs
unset unless a repo needs something other than `src/models.json`'s chains.

Where org secrets do not reach private repositories (GitHub Free), the key is a
repository secret instead. Fork pull requests are skipped: they get no secrets,
and running fork code on a self-hosted runner is not something to arrange by
accident.

### Keeping a PR away from the critic

A PR labelled `no-critic` should never have its diff sent to a model vendor, for example a
fix for a security finding that is not public yet. The label has to be on the PR when it
opens, because the `opened` event carries the labels it was created with. Each caller
checks it in its own job condition, on both the PR path and the `/critic` comment path:

```yaml
    if: >-
      (github.event_name == 'pull_request' &&
       !contains(github.event.pull_request.labels.*.name, 'no-critic') && ...) ||
      (github.event_name == 'issue_comment' &&
       !contains(github.event.issue.labels.*.name, 'no-critic') && ...)
```

`gh pr create --label` adds the label in a second call, after `opened` has fired, so a
PR that must stay private opens as a draft (every caller skips drafts) and is marked ready
only once the label is confirmed; `ready_for_review` carries the current labels.
`/dev:pr-land --local-only` works that way and refuses a repo whose `pr-review.yml` has no
uncommented line with the negated `!contains(…, 'no-critic')` check.

An org that restricts Actions to an allowlist needs `jroehl/gh-workflows@*` on it.
The action sits at the repo root for exactly that reason: a pattern of that shape
does not match an action in a subdirectory, and the refusal arrives as a
`startup_failure` with no log, no annotation and no check run.
