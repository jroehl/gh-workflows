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
  // --function-context, not a bare hunk: a refuter that cannot see the function a
  // changed line sits in kills true findings as UNPROVEN, which is the expensive
  // failure here. Measured on a real PR, two correct findings died that way.
  const raw = git(
    ["diff", "--function-context", "--unified=10", range, "--", ".", ...pathspec],
    cwd,
  );
  const commits = git(["log", "--format=%s%n%b", `${base}..HEAD`], cwd).trim();
  const { diff, truncated } = truncate(raw, budget);

  // --no-renames lists a rename as the old path deleted and the new one added, so a
  // code file moved into docs/ still counts as a code change.
  const paths = git(["diff", "--name-only", "--no-renames", "-z", range, "--", ".", ...pathspec], cwd)
    .split("\0")
    .filter(Boolean);
  const mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();
  const attrs = readGenerated({ paths, source: mergeBase, cwd });
  const files = paths.map((path) => ({ path, generated: attrs.generated.has(path) }));

  return { stat, diff, commits, truncated, empty: raw.trim() === "", files, attrError: attrs.error };
}

// The linguist-generated attribute of each path as the tree `source` defines it, never
// the checkout: a PR must not be able to mark its own changes generated. A failure
// (git older than 2.40 has no --source, or a bad tree) marks nothing generated, so
// the file is reviewed: the safe direction to be wrong in.
export function readGenerated({ paths, source, cwd }) {
  const generated = new Set();
  if (paths.length === 0) return { generated, error: null };
  let out;
  try {
    out = execFileSync("git", ["check-attr", "--source", source, "-z", "--stdin", "linguist-generated"], {
      cwd,
      input: paths.map((p) => `${p}\0`).join(""),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail = String(err.stderr ?? err.message).trim().split("\n")[0];
    return { generated, error: `git check-attr --source ${source} failed: ${detail}` };
  }
  // -z output is path NUL attribute NUL value NUL, repeated.
  const parts = out.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === "set" || parts[i + 2] === "true") generated.add(parts[i]);
  }
  return { generated, error: null };
}

// Markdown that carries instructions for an agent or for GitHub is reviewed like code. Tool
// config lives in dot-directories (.claude, .github, .cursor, .codex, ...) and new agents keep
// adding names, so every dot-directory counts, not a list that falls behind.
const INSTRUCTION_DIRS = new Set(["prompts", "prompt", "skills", "agents", "instructions"]);
const INSTRUCTION_FILES = new Set(["agents.md", "claude.md", "gemini.md", "skill.md", "copilot-instructions.md"]);

function isPlainDoc(path) {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1);
  if (!/\.mdx?$/.test(name)) return false;
  if (INSTRUCTION_FILES.has(name) || name.includes("prompt")) return false;
  return !parts.slice(0, -1).some((d) => d.startsWith(".") || INSTRUCTION_DIRS.has(d));
}

// A diff is not worth a model call when every file is plain documentation or marked
// generated. A .gitattributes change is never skippable: it changes what counts as
// generated for every later PR.
export function shouldSkip(files) {
  if (files.length === 0) return null;
  let docs = 0;
  let generated = 0;
  for (const f of files) {
    if (f.path.split("/").at(-1) === ".gitattributes") return null;
    if (f.generated) generated++;
    else if (isPlainDoc(f.path)) docs++;
    else return null;
  }
  const kinds = [docs && `${docs} doc`, generated && `${generated} generated`].filter(Boolean).join(", ");
  return { reason: `only documentation or generated files changed (${kinds})`, files: files.length };
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
