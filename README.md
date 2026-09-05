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
  --critic-model <id>     default x-ai/grok-4.3
  --critic-fallback-model <id>
                          used when the critic fails; default openai/gpt-5.1,
                          empty string to disable
  --refuter-model <id>    default google/gemini-3.1-pro-preview
  --exclude <pathspec>    extra path to leave out of the diff (repeatable)
  --keep-unproven         keep findings the refuter could not settle
  --json <path>           also write the full result as JSON
```

Surviving findings go to stdout as JSON; progress goes to stderr. Findings the
refuter killed stay in the payload under `dismissed` with the reason, because a
finding that disappears without a reason is worse than one that was wrong.

Roughly 3-6 cents per review at the default models, most of it the critic's
reasoning tokens.

## When no review runs

A critic that answers with an empty string looks the same as a clean review, so a
failed run says so out loud. The fallback critic gets a turn first; if that fails
too, the run posts a comment on the pull request naming the models it called and
the error, and removes it again once a review lands. CI stays green either way,
because a model outage is not the author's problem to fix.

## Choosing models

The only hard rule is that critic and refuter come from different families, and
neither is the family that wrote the code. Measured while building this: on a claim
that depended on code outside the diff, `gemini-3.1-flash-lite` confirmed it while
`gemini-3.1-pro-preview` correctly returned UNPROVEN. The refuter is the wrong place
to save money.

The critic, its fallback and the refuter are three different families, so the
separation survives the run where the first critic fails.

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

Add a caller stub to the repo. The workflow lives here and is public, so any
owner can call it; each supplies its own `OPENROUTER_API_KEY`.

```yaml
name: PR review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: jroehl/gh-workflows/.github/workflows/pr-review.yml@main
    secrets:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    with:
      runs-on: ubuntu-22.04   # or a self-hosted label where you have runners
```

Where org secrets do not reach private repositories (GitHub Free), the key is a
repository secret instead. Fork pull requests are skipped: they get no secrets,
and running fork code on a self-hosted runner is not something to arrange by
accident.

An org that restricts Actions to an allowlist needs `jroehl/gh-workflows@*` on it.
The action sits at the repo root for exactly that reason: a pattern of that shape
does not match an action in a subdirectory, and the refusal arrives as a
`startup_failure` with no log, no annotation and no check run.
