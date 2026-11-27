import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transportError } from "./errors.mjs";

const TIMEOUT_MS = 15 * 60_000;

// What codex-cli 0.172.0 lets a run switch off, read from `codex features list`,
// `codex exec --help` and its config reference, and checked with `codex debug
// prompt-input`: shell (exec_command, write_stdin), image viewing, browser and computer
// use, apps, plugins, hooks, multi-agent, skills search, web search and MCP servers all
// go. What no flag removes is apply_patch (refused anyway by the read-only sandbox, and
// it cannot read), the MCP resource readers (no server is configured) and a clock.
// None of what is left reads a file or the network, so the prompt is the only input.
const DISABLE = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "view_image",
  "image_generation",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "apps",
  "plugins",
  "remote_plugin",
  "hooks",
  "multi_agent",
  "goals",
  "sleep_tool",
  "skill_search",
  "tool_suggest",
  "code_mode_host",
];
const CONFIG = [
  'web_search="disabled"',
  "mcp_servers={}",
  "skills.bundled.enabled=false",
  "agents.enabled=false",
  "project_doc_max_bytes=0",
];

export function codexArgs({ model, cwd, schemaFile, outFile }) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "-m",
    model,
    "--output-schema",
    schemaFile,
    "-o",
    outFile,
    "--json",
    ...DISABLE.flatMap((f) => ["--disable", f]),
    ...CONFIG.flatMap((c) => ["-c", c]),
    "-",
  ];
}

function classify(output) {
  if (/usage limit|rate limit|quota|too many requests|\b429\b/i.test(output)) return "codex_quota";
  if (/not logged in|log ?in|unauthori[sz]ed|\b401\b|token (has )?expired|refresh token/i.test(output)) return "codex_auth";
  return "codex_exit";
}

// --json prints one event per line; turn.completed carries the token counts.
function usageFrom(stdout) {
  const usage = { cost: 0 };
  for (const line of stdout.split("\n")) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type === "turn.completed" && ev.usage) {
      usage.prompt_tokens = (usage.prompt_tokens ?? 0) + (ev.usage.input_tokens ?? 0);
      usage.cached_tokens = (usage.cached_tokens ?? 0) + (ev.usage.cached_input_tokens ?? 0);
      usage.completion_tokens = (usage.completion_tokens ?? 0) + (ev.usage.output_tokens ?? 0);
    }
  }
  return usage;
}

// One prompt through `codex exec` on the ChatGPT subscription. The read-only sandbox
// still lets a shell read files, so the boundary is three things together: an empty
// working directory, the tools above switched off, and an environment holding only
// PATH, HOME and CODEX_HOME, so no API key or token in the caller's environment can
// reach the model. The schema is the role's, so codex answers in the same shape as
// every other transport. Nothing here is ever fatal: any failure moves the chain on.
// onOutput, when given, receives codex's raw --json event stream (the live sentinel
// check reads it for tool calls); nothing in the CLI passes it.
export async function completeCodex({ model, entry, system, user, schema, budget, stage, timeoutMs, onOutput }) {
  const apiModel = entry?.api_model ?? model.slice(model.indexOf(":") + 1);
  const limit = Number(timeoutMs ?? process.env.PR_CRITIC_CODEX_TIMEOUT_MS ?? TIMEOUT_MS);
  const home = process.env.HOME ?? "";
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    CODEX_HOME: process.env.CODEX_HOME ?? join(home, ".codex"),
  };

  const dir = mkdtempSync(join(tmpdir(), "pr-critic-codex-"));
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const schemaFile = join(dir, "schema.json");
  const outFile = join(dir, "answer.json");
  writeFileSync(schemaFile, JSON.stringify(schema ?? { type: "object" }));

  try {
    const { code, stdout, stderr, timedOut, spawnError } = await new Promise((resolve) => {
      let out = "";
      let err = "";
      let timer;
      let child;
      try {
        // Its own process group: the codex launcher is a node script that starts the
        // native binary, and killing the launcher alone would leave the binary holding
        // the pipes open.
        child = spawn("codex", codexArgs({ model: apiModel, cwd, schemaFile, outFile }), {
          env,
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
      } catch (e) {
        resolve({ spawnError: e });
        return;
      }
      timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        resolve({ timedOut: true });
      }, limit);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ spawnError: e });
      });
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err, timedOut: false });
      });
      child.stdin.on("error", () => {
        /* codex gone before reading stdin; the exit code says why */
      });
      child.stdin.end(`${system}\n\n${user}`);
    });

    if (onOutput) onOutput({ code, stdout, stderr, timedOut });
    if (spawnError) {
      throw transportError("codex", "codex_spawn", `codex could not be started: ${spawnError.message}`);
    }
    if (timedOut) throw transportError("codex", "codex_timeout", `codex ${apiModel} did not answer within ${limit} ms`);
    if (code !== 0) {
      const tail = `${stderr}\n${stdout}`.trim().slice(-400);
      throw transportError("codex", classify(tail), `codex exited ${code}: ${tail}`);
    }

    const usage = usageFrom(stdout);
    if (budget) budget.debit(stage, 0, false);
    let text = "";
    try {
      text = readFileSync(outFile, "utf8").trim();
    } catch {
      /* no answer written */
    }
    try {
      JSON.parse(text);
    } catch {
      throw transportError("codex", "codex_parse", `codex ${apiModel} did not answer in JSON: ${text.slice(0, 200)}`);
    }
    return { text, usage, cost: 0, estimated: false, model, paid_by: "codex-subscription" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
