import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../bin/pr-critic.mjs";
import { fakeFetch, oaReply, orReply, tempRepo, withEnv } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// No YAML dependency: action.yml is read as lines, which works because its layout is
// fixed (two-space indents, one `run: |` block per step). A layout change that breaks
// this parser fails these tests loudly rather than passing on nothing.
const ACTION = readFileSync(new URL("../action.yml", import.meta.url), "utf8").split("\n");

function inputDefaults() {
  const out = {};
  let i = ACTION.indexOf("inputs:") + 1;
  let name = null;
  for (; i < ACTION.length && (ACTION[i] === "" || ACTION[i].startsWith(" ")); i++) {
    const head = /^ {2}([a-z0-9-]+):\s*$/.exec(ACTION[i]);
    if (head) {
      name = head[1];
      out[name] = "";
      continue;
    }
    const def = /^ {4}default:\s*(.*)$/.exec(ACTION[i]);
    if (def && name) out[name] = def[1].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function reviewStep() {
  const start = ACTION.findIndex((l) => l.trim() === "- name: Review");
  assert.ok(start > 0, "no Review step in action.yml");
  const env = {};
  let i = start + 1;
  while (ACTION[i].trim() !== "env:") i++;
  for (i++; /^ {8}[A-Z_]+:/.test(ACTION[i]); i++) {
    const [, k, v] = /^ {8}([A-Z_]+):\s*(.*)$/.exec(ACTION[i]);
    env[k] = v;
  }
  while (!/^ {6}run: \|/.test(ACTION[i])) i++;
  const body = [];
  for (i++; i < ACTION.length && (ACTION[i] === "" || ACTION[i].startsWith("        ")); i++) {
    body.push(ACTION[i].slice(8));
  }
  return { env, run: body.join("\n") };
}

// Evaluates the step's env: block the way the runner would, for the two expression
// shapes it uses.
function stepEnv(inputs) {
  const { env } = reviewStep();
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^\$\{\{\s*(inputs|github)\.([a-z0-9_-]+)\s*\}\}$/.exec(v);
    assert.ok(m, `unexpected env expression ${k}: ${v}`);
    out[k] = m[1] === "inputs" ? (inputs[m[2]] ?? "") : m[2] === "repository" ? "o/r" : "";
  }
  return out;
}

// Runs the Review step's shell with a fake `node` that records its argv and exits
// with `rc`. Returns the argv the CLI would have got, and what the step printed.
function runStep(withInputs = {}, { rc = 0 } = {}) {
  const inputs = { ...inputDefaults(), pr: "7", "openrouter-api-key": "sk-or-SECRET", "github-token": "ghs-SECRET", ...withInputs };
  const bin = mkdtempSync(join(tmpdir(), "pr-critic-fake-node-"));
  const argvFile = join(bin, "argv");
  writeFileSync(
    join(bin, "node"),
    `#!/bin/sh\nshift\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${argvFile}"\nexit ${rc}\n`,
  );
  chmodSync(join(bin, "node"), 0o755);
  const res = spawnSync("bash", ["-c", reviewStep().run], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_ACTION_PATH: "/action",
      GITHUB_BASE_REF: "main",
      ...stepEnv(inputs),
    },
    encoding: "utf8",
  });
  let argv = [];
  try {
    argv = readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
  } catch {
    /* node never ran */
  }
  return { argv, status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("action: default inputs pass no model flag and keep the keys out of argv", () => {
  const { argv, status } = runStep({ "openai-api-key": "sk-oa-SECRET", "anthropic-api-key": "sk-an-SECRET" });
  assert.equal(status, 0);
  for (const flag of ["--critic-model", "--critic-fallback-model", "--refuter-model", "--no-skip", "--max-cost"]) {
    assert.ok(!argv.includes(flag), `${flag} in ${argv.join(" ")}`);
  }
  assert.ok(!argv.some((a) => a.includes("SECRET")), argv.join(" "));
  assert.deepEqual(argv.slice(0, 6), ["--base", "origin/main", "--pr", "7", "--repo", "o/r"]);
  assert.ok(argv.includes("--post"));
});

test("action: the key inputs reach the step as env, not argv", () => {
  const env = stepEnv({ ...inputDefaults(), "openai-api-key": "a", "anthropic-api-key": "b", "openrouter-api-key": "c" });
  assert.equal(env.OPENAI_API_KEY, "a");
  assert.equal(env.ANTHROPIC_API_KEY, "b");
  assert.equal(env.OPENROUTER_API_KEY, "c");
});

test("action: set inputs become flags", () => {
  const { argv } = runStep({
    "critic-model": "x-ai/grok-4.3",
    "critic-fallback-model": "openai/gpt-6.1-sol",
    "refuter-model": "google/gemini-3.1-pro-preview",
    "max-cost": "0.25",
    "no-skip": "true",
    post: "false",
  });
  const after = (f) => argv[argv.indexOf(f) + 1];
  assert.equal(after("--critic-model"), "x-ai/grok-4.3");
  assert.equal(after("--critic-fallback-model"), "openai/gpt-6.1-sol");
  assert.equal(after("--refuter-model"), "google/gemini-3.1-pro-preview");
  assert.equal(after("--max-cost"), "0.25");
  assert.ok(argv.includes("--no-skip"));
  assert.ok(!argv.includes("--post"));
});

test("action: no-skip false passes no flag", () => {
  assert.ok(!runStep({ "no-skip": "false" }).argv.includes("--no-skip"));
});

test("action: exit 3 fails the step with an error that covers config and a rejected last key", () => {
  const { status, stdout } = runStep({}, { rc: 3 });
  assert.equal(status, 1);
  assert.match(stdout, /::error::/);
  assert.match(stdout, /configuration/i);
  assert.match(stdout, /key/i);
  assert.doesNotMatch(stdout, /could not authenticate to OpenRouter/);
});

test("action: any other failure stays green with a warning", () => {
  const { status, stdout } = runStep({}, { rc: 1 });
  assert.equal(status, 0);
  assert.match(stdout, /::warning::/);
});

test("action: default inputs with CI=true and OPENAI_API_KEY start the critic chain at openai:", async () => {
  const { argv } = runStep({ "openai-api-key": "sk-oa" });
  // The CLI is run in-process so fetch can be faked; the base and JSON path are the
  // only arguments swapped, for a temp repo and a temp file.
  const json = join(mkdtempSync(join(tmpdir(), "pr-critic-json-")), "out.json");
  const args = argv.map((a, i) => (argv[i - 1] === "--base" ? "HEAD~1" : argv[i - 1] === "--json" ? json : a));
  const cwd = tempRepo();
  fakeFetch({
    answers: { "gpt-6.1-sol": [oaReply('{"findings":[]}')], "x-ai/grok-4.3": [orReply('{"findings":[]}')] },
    github: {
      "POST /repos/o/r/pulls/7/reviews": () => new Response(JSON.stringify({ id: 1 }), { status: 200 }),
      "GET /repos/o/r/pulls/7/reviews": () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }),
    },
  });
  const { result } = await withEnv(
    { CI: "true", OPENAI_API_KEY: "sk-oa", OPENROUTER_API_KEY: "k", GITHUB_TOKEN: "t" },
    () => main({ argv: args, cwd }),
  );
  assert.equal(result.code, 0);
  assert.match(result.result.meta.chain.critic[0], /^openai:/);
  assert.equal(result.result.meta.critic, "openai:gpt-6.1-sol");
  assert.ok(JSON.parse(readFileSync(json, "utf8")).meta);
});

test("action: this repo's workflow passes both credit keys and no-skip on /critic", () => {
  const wf = readFileSync(new URL("../.github/workflows/pr-review.yml", import.meta.url), "utf8");
  assert.match(wf, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.match(wf, /anthropic-api-key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(wf, /no-skip: \$\{\{ github\.event_name == 'issue_comment' \}\}/);
});

test("action: bash -n accepts the Review step", () => {
  execFileSync("bash", ["-n", "-c", reviewStep().run]);
});
