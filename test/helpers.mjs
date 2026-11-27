import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A throwaway repo with one change on top of a base commit. The user's global git
// config is kept out so a signing setup or hooks there cannot touch it.
export function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pr-critic-test-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  git("add", "a.js");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(dir, "a.js"), "export const a = 2;\nexport const b = a / 0;\n");
  git("commit", "-q", "-am", "change");
  return dir;
}

export const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

export function orReply(content, usage = { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 }) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export const OPENAI = "https://api.openai.com/v1/chat/completions";
export const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const LLM = { [OPENROUTER]: "openrouter", [OPENAI]: "openai", [ANTHROPIC]: "anthropic" };

// An OpenAI chat completion, the shape the openai: transport reads.
export function oaReply(content, { usage = { prompt_tokens: 1000, completion_tokens: 100 }, finish = "stop" } = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// An Anthropic Messages response. Adaptive thinking puts a thinking block first.
export function anReply(text, { usage = { input_tokens: 1000, output_tokens: 100 }, stop = "end_turn" } = {}) {
  const content = [{ type: "thinking", thinking: "..." }];
  if (text !== null) content.push({ type: "text", text });
  return new Response(JSON.stringify({ type: "message", role: "assistant", content, stop_reason: stop, usage }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function apiError(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// One fake for every API. Model answers come from `answers`, keyed by the model name
// in the request body (OpenRouter, OpenAI and Anthropic alike), each a list consumed
// in order; GitHub routes are "METHOD /path".
export function fakeFetch({ answers = {}, github = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url in LLM) {
      const body = JSON.parse(init.body);
      calls.push({ kind: LLM[url], model: body.model, body, headers: init.headers ?? {} });
      const queue = answers[body.model];
      if (!queue || queue.length === 0) return new Response(`no answer for ${body.model}`, { status: 500 });
      const next = queue.shift();
      return typeof next === "function" ? next(body) : next;
    }
    const u = new URL(url);
    calls.push({ kind: "github", method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const handler = github[`${method} ${u.pathname}`];
    if (!handler) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    return handler(u, init);
  };
  return calls;
}

// A fake `codex` on PATH. `exec` writes `answer` to the -o file after printing the
// JSONL events codex prints with --json; `login status` reports a ChatGPT login unless
// loggedIn is false. Each call's argv, environment and stdin land in calls.log, so a
// test can see what codex was given. `exec` exits with `exit`, after `sleep` seconds.
export function fakeCodex({ answer = '{"findings":[]}', exit = 0, stderr = "", sleep = 0, loggedIn = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-critic-fake-codex-"));
  writeFileSync(join(dir, "answer.json"), answer);
  writeFileSync(join(dir, "stderr.txt"), stderr);
  const script = `#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
{ echo "ARGV $*"; env | sed 's/^/ENV /'; } >> "$here/calls.log"
if [ "$1" = "login" ]; then
  if [ ${loggedIn ? 1 : 0} = 1 ]; then echo "Logged in using ChatGPT"; exit 0; fi
  echo "Not logged in"; exit 1
fi
out=""; cd_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -C) cd_dir="$2"; shift ;;
  esac
  shift
done
echo "CDLIST $(ls -A "$cd_dir" | tr '\\n' ' ')" >> "$here/calls.log"
cat | sed 's/^/STDIN /' >> "$here/calls.log"
sleep ${sleep}
cat "$here/stderr.txt" >&2
if [ ${exit} != 0 ]; then exit ${exit}; fi
echo '{"type":"thread.started","thread_id":"t"}'
echo '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"ok"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":200,"output_tokens":300}}'
cp "$here/answer.json" "$out"
`;
  writeFileSync(join(dir, "codex"), script);
  chmodSync(join(dir, "codex"), 0o755);
  return { dir, log: () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "") };
}

export function finding(overrides = {}) {
  return {
    file: "a.js",
    line: 2,
    severity: "high",
    claim: "division by zero",
    failure_scenario: "import a.js -> b is Infinity",
    confidence: "high",
    ...overrides,
  };
}

// Runs fn with process.env and console.log temporarily replaced. CI is set unless the
// test unsets it (CI: undefined): a local-looking environment would let the codex:
// link spawn the real codex on a machine where it is logged in.
export async function withEnv(env, fn) {
  const saved = { ...process.env };
  const log = console.log;
  const err = console.error;
  const stderr = [];
  const stdout = [];
  for (const k of Object.keys(process.env)) delete process.env[k];
  const kept = { PATH: saved.PATH, HOME: saved.HOME, ...(saved.TMPDIR ? { TMPDIR: saved.TMPDIR } : {}) };
  Object.assign(process.env, kept, { CI: "true" }, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  console.log = (...a) => stdout.push(a.join(" "));
  console.error = (...a) => stderr.push(a.join(" "));
  try {
    return { result: await fn(), stderr, stdout };
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    console.log = log;
    console.error = err;
  }
}

// A throwaway repo whose base commit holds `base` and whose HEAD commit applies
// `change` on top, both {path: content}; a null content deletes the file.
export function repoWith(base, change) {
  const dir = mkdtempSync(join(tmpdir(), "pr-critic-test-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  const write = (files) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        git("rm", "-q", "--", path);
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      git("add", "--", path);
    }
  };
  git("init", "-q", "-b", "main");
  write({ "seed.txt": "seed\n", ...base });
  git("commit", "-q", "-m", "base");
  write(change);
  git("commit", "-q", "-m", "change");
  return dir;
}
