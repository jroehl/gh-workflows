# gh-workflows

One tool: `pr-critic`, a cross-model adversarial PR review. A critic reads the diff, a
refuter from another family attacks each finding, survivors are posted as one GitHub
review. `README.md` carries the research the design rests on and the user-facing flags.
This file is the parts that are easy to get wrong.

## Changes here do not reach anyone until fourteen repos move

Consumers pin this action by SHA, so a merge to `main` changes nothing for them. This file
listed three of them until 2026-11-05, when a code search found fourteen, half of them on an
older pin. Find them with `gh search code 'jroehl/gh-workflows' --owner HINTERLAND-software`
rather than trusting a list. On 2026-11-05 every one got a PR moving it to `968b32d` in
`.github/workflows/pr-review.yml`: homelab (merged), infrastructure, frooma, meal-planner,
Dalbi, five-minutes, the two `lambda.*-estate-api` repos and four `web.*` sites on `main`,
plus web.giga-hamburg and simple-frame on **staging**, which reach main on their next
promotion.

Renovate offers the digest bump on giga only, monthly and without automerge. The others run
Dependabot, which resolves actions to releases or tags, so a branch-pinned SHA is invisible
to it. From v2.0.0 on, releases are tagged, and consumers pin `@<sha> # v2.0.0`: both bots
read the trailing tag comment and open the bump themselves.

Cutting a release:

1. Merge to `main`, with `package.json` `version` already at the new number.
2. Tag the merge commit `vX.Y.Z` and move the major tag onto it:
   `git tag vX.Y.Z <sha> && git tag -f vX <sha>`, then push both (`git push origin vX.Y.Z`,
   and `git push -f origin vX`, which the push guard will ask about).
3. Check with `git ls-remote --tags origin`, not with what push printed.

A new input or a changed default is a minor version; a removed input or a flag the old
`action.yml` would pass and the new CLI rejects is a major one. `a5485f9`, the last commit
before the chains, is tagged `v1.0.0` before `v2.0.0` is cut, as the rollback target:
Dependabot never downgrades, so a rollback is a repin by hand.

This repo's own `.github/workflows/pr-review.yml` uses `uses: ./` and needs no bump.

## The model budget is shared with reasoning tokens

`MAX_TOKENS` in `src/cost.mjs` caps reasoning plus content. A reasoning model that
spends the whole allowance thinking is cut off before writing a character and returns an
empty string with `finish_reason: "length"` — an HTTP 200 that looks exactly like a clean
review. That is what silently killed reviews for a day at the old ceiling of 8000:
`openai/gpt-5.1-codex` needs about 24k reasoning tokens on a 42k-character diff.

So the ceiling is 32000, and an empty answer names its `finish_reason` rather than saying
only that there wasn't one. OpenRouter bills tokens produced, not the cap, so raising it
costs nothing until something uses it.

## Chains, the allowlist and the family rule live in `src/models.json`

Each role has an ordered chain there, and the file is also the allowlist: every permitted ID
with its family and its price per million tokens. It is the one place a default lives. The
action's model inputs default to `""` and are passed only when set, and the CLI's `--help`
prints the chains from the registry, so `grep -nE 'gemini|grok|gpt-|claude-' action.yml
bin/pr-critic.mjs` should find nothing. An ID off the list is refused before any call
unless `--allow-any-model` is passed, and the action deliberately has no input for that
flag: CI cannot leave the allowlist.

The family rule is code (`assertChains` in `src/models.mjs`), checked on the chain as it
will run, after links without a credential are dropped:

- no critic link is Anthropic;
- the critic chain has a second family, so the run where every link of the first family
  fails still gets a cross-family critic. `openai:`, `codex:` and `openai/` are one family:
  consecutive links of it are retries, not a second opinion;
- no refuter link shares a family with any critic link;
- an Anthropic refuter needs `refuter_ok_anthropic: true` on its registry entry, which is set
  only from an A/B result (`ab/results-2026-11.md` for `claude-haiku-5.5`).

A violation is a config error: the "no review ran" notice with stage `config`, then exit 3.
Changing a price or a chain is a one-file change, but a new model also needs its `roles`.

## The Codex transport is local only

A `codex:<model>` link runs `codex exec` on Johann's ChatGPT subscription. It is dropped
whenever `CI` is set, so the ChatGPT login stays on the mini and CT 110 and never reaches a
runner; CI reaches OpenAI through the `openai:` link and its capped API key instead. The run
is prompt-only: an empty temp dir, a scrubbed environment (`PATH`, `HOME`, `CODEX_HOME`), a
read-only sandbox, and every tool codex-cli lets a run switch off switched off (the list and
why is at the top of `src/codex.mjs`). Any codex failure fails over to the next link.

**`codex login status` does not prove a live login.** The link is kept when that command
exits 0 and names ChatGPT, but it reads the stored credentials without refreshing them. On
the mini on 2026-11-27 the refresh token had been revoked while `login status` still said
"Logged in using ChatGPT", so every local run tried `codex:` first and failed over as
`codex_auth`. The review still lands, through OpenRouter, so this shows only in
`meta.chain.attempts`. The fix is `codex logout && codex login`.

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

## GitHub list reads walk every page

A list endpoint returns 30 items by default, and a read that stops at page one looks like a
short list. On `homelab#344` (40 reviews) that made the post-check report the review it had
just created as missing. Read lists through `ghPages`/`ghAll` in `src/post.mjs`, which ask
for 100 per page and follow the `Link` header; never call `gh()` on a list. `npm test`
checks this offline against a fake API that pages the way GitHub does.

## System gotchas

- [pr-critic action contract](.claude/rules/pr-critic-action.md) — why the step runs
  `$GITHUB_ACTION_PATH` instead of npx, what each exit code means for the check (the
  cost cap included), and the four places a new input goes.
