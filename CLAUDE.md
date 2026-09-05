# gh-workflows

One tool: `pr-critic`, a cross-model adversarial PR review. A critic reads the diff, a
refuter from another family attacks each finding, survivors are posted as one GitHub
review. `README.md` carries the research the design rests on and the user-facing flags.
This file is the parts that are easy to get wrong.

## Changes here do not reach anyone until three repos move

Consumers pin this action by SHA, so a merge to `main` changes nothing for them. As of
2026-09-05 all three sit at `e32c63f`, each in `.github/workflows/pr-review.yml`:

- `HINTERLAND-software/homelab` (main)
- `HINTERLAND-software/infrastructure` (main)
- `HINTERLAND-software/web.giga-hamburg` (**staging**, which is ahead of main; it reaches
  main on the next promotion)

Renovate offers the digest bump on giga only, monthly and without automerge. The other two
run Dependabot, which resolves actions to releases or tags; this repo has neither, so a
branch-pinned SHA is invisible to it and those two are bumped by hand. Tagging releases
would change that.

This repo's own `.github/workflows/pr-review.yml` uses `uses: ./` and needs no bump.

## The model budget is shared with reasoning tokens

`max_tokens` in `src/openrouter.mjs` caps reasoning plus content. A reasoning model that
spends the whole allowance thinking is cut off before writing a character and returns an
empty string with `finish_reason: "length"` — an HTTP 200 that looks exactly like a clean
review. That is what silently killed reviews for a day at the old ceiling of 8000:
`openai/gpt-5.1-codex` needs about 24k reasoning tokens on a 42k-character diff.

So the ceiling is 32000, and an empty answer names its `finish_reason` rather than saying
only that there wasn't one. OpenRouter bills tokens produced, not the cap, so raising it
costs nothing until something uses it.

## Critic, fallback and refuter are three families

Never Anthropic for the critic, never the critic's family for the refuter. The fallback is
a third family so the separation holds on the run where the first critic fails. Defaults
live in `bin/pr-critic.mjs` `DEFAULTS`, in the `action.yml` inputs and in the `README.md`
usage block; all three have to move together.

## Running it locally

```bash
OPENROUTER_API_KEY="$(mint openrouter --limit 5)" node bin/pr-critic.mjs --base origin/main
```

That line works from a shell script. Typed straight into an agent's Bash call it does not:
the harness scrubs secret-shaped strings out of a command's stdout before the redirect or
the substitution sees it, so `sk-or-v1-<64 hex>` arrives truncated to `sk-or-v1-` and the
key silently fails to authenticate. `mint` itself is fine, one line on stdout, nothing on
stderr. Put the `mint` call inside a script the agent invokes, and the full token comes
through. `mint revoke openrouter` afterwards, always.

The CLI needs commits: `collectContext` diffs `base...HEAD` between trees, so uncommitted
work is invisible to it. To review another repo's PR without touching a working copy, clone
with `--filter=blob:none --no-checkout`, `git fetch origin refs/pull/N/head:refs/pr/N`, then
`git update-ref HEAD refs/pr/N`. A tree-to-tree diff needs no checked-out files.

## System gotchas

- [pr-critic action contract](.claude/rules/pr-critic-action.md) — why the step runs
  `$GITHUB_ACTION_PATH` instead of npx, and what each exit code means for the check.
