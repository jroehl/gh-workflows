import { execFileSync } from "node:child_process";

const DEFAULT_EXCLUDES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "*.snap",
  "*.min.js",
  "*.map",
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// A diff bigger than the budget is truncated per file rather than globally, so a
// large lockfile-shaped change cannot starve every other file of review.
function truncate(diff, budget) {
  if (diff.length <= budget) return { diff, truncated: false };
  const files = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const per = Math.max(2000, Math.floor(budget / Math.max(files.length, 1)));
  const kept = files.map((f) =>
    f.length > per ? `${f.slice(0, per)}\n… [file truncated at ${per} chars]\n` : f,
  );
  return { diff: kept.join(""), truncated: true };
}

export function collectContext({ base, cwd = process.cwd(), excludes = [], budget = 220_000 }) {
  const pathspec = [...DEFAULT_EXCLUDES, ...excludes].map((p) => `:(exclude)${p}`);

  // Three dots: the diff against the merge base, so commits landed on the base
  // branch since branching are not reported as this branch's changes.
  const range = `${base}...HEAD`;
  const stat = git(["diff", "--stat", range, "--", ".", ...pathspec], cwd).trim();
  const raw = git(["diff", "--unified=3", range, "--", ".", ...pathspec], cwd);
  const commits = git(["log", "--format=%s%n%b", `${base}..HEAD`], cwd).trim();
  const { diff, truncated } = truncate(raw, budget);

  return { stat, diff, commits, truncated, empty: raw.trim() === "" };
}

export async function fetchPrIntent({ repo, pr, token }) {
  if (!repo || !pr) return null;
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return { title: body.title, body: body.body ?? "", base: body.base?.ref };
}
