import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectContext, shouldSkip, readGenerated } from "../src/context.mjs";
import { main } from "../bin/pr-critic.mjs";
import { fakeFetch, orReply, repoWith, withEnv } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CODE = "export const a = 1;\n";
const skipOf = (base, change) => {
  const cwd = repoWith(base, change);
  return shouldSkip(collectContext({ base: "HEAD~1", cwd }).files);
};

// ---------- the rule, on temp repos ----------

test("skip: a README-only change is skipped", () => {
  assert.ok(skipOf({ "README.md": "a\n" }, { "README.md": "b\n" }));
});

test("skip: README plus src/a.js is reviewed", () => {
  assert.equal(skipOf({ "src/a.js": CODE }, { "README.md": "b\n", "src/a.js": "export const a = 2;\n" }), null);
});

test("skip: .claude/rules/x.md is reviewed, because rule files carry instructions", () => {
  assert.equal(skipOf({}, { ".claude/rules/x.md": "do this\n" }), null);
});

test("skip: markdown under .github/, and AGENTS.md and CLAUDE.md anywhere, are reviewed", () => {
  for (const path of [".github/pull_request_template.md", "AGENTS.md", "CLAUDE.md", "sub/CLAUDE.md", "pkg/.claude/x.md"]) {
    assert.equal(skipOf({}, { [path]: "x\n" }), null, path);
  }
});

test("skip: docs in any directory, .mdx included, are skipped", () => {
  assert.ok(skipOf({}, { "docs/guide.mdx": "x\n", "docs/notes/CHANGES.MD": "y\n" }));
});

test("skip: a file the base tree marks linguist-generated is skipped", () => {
  const files = collectContext({
    base: "HEAD~1",
    cwd: repoWith({ ".gitattributes": "dist/** linguist-generated\n", "dist/out.js": CODE }, { "dist/out.js": "x\n" }),
  }).files;
  assert.deepEqual(files, [{ path: "dist/out.js", generated: true }]);
  assert.ok(shouldSkip(files));
});

test("skip: generated plus docs together are skipped", () => {
  const base = { ".gitattributes": "dist/** linguist-generated=true\n", "dist/out.js": CODE };
  assert.ok(skipOf(base, { "dist/out.js": "x\n", "README.md": "y\n" }));
});

test("skip: linguist-generated=false does not count as generated", () => {
  const base = { ".gitattributes": "dist/** linguist-generated=false\n", "dist/out.js": CODE };
  assert.equal(skipOf(base, { "dist/out.js": "x\n" }), null);
});

test("skip: a PR that adds .gitattributes marking src/a.js generated is reviewed", () => {
  const cwd = repoWith({ "src/a.js": CODE }, { ".gitattributes": "src/a.js linguist-generated\n", "src/a.js": "x\n" });
  const { files } = collectContext({ base: "HEAD~1", cwd });
  // Attributes come from the base tree, where src/a.js is not generated.
  assert.deepEqual(files.find((f) => f.path === "src/a.js"), { path: "src/a.js", generated: false });
  assert.equal(shouldSkip(files), null);
});

test("skip: the checked-out .gitattributes is ignored; only the base tree decides", () => {
  const cwd = repoWith({ "src/a.js": CODE }, { "src/a.js": "x\n" });
  writeFileSync(join(cwd, ".gitattributes"), "src/** linguist-generated\n");
  const { files } = collectContext({ base: "HEAD~1", cwd });
  assert.deepEqual(files, [{ path: "src/a.js", generated: false }]);
  assert.equal(shouldSkip(files), null);
});

test("skip: a change to a nested .gitattributes is never skippable, even when the base marks it generated", () => {
  const base = { ".gitattributes": "docs/** linguist-generated\n", "docs/.gitattributes": "*.md text\n" };
  assert.equal(skipOf(base, { "docs/.gitattributes": "*.md linguist-generated\n" }), null);
});

test("skip: a rename out of code into docs is reviewed, since the code file goes away", () => {
  assert.equal(skipOf({ "src/a.js": CODE }, { "src/a.js": null, "docs/a.md": CODE }), null);
});

test("skip: an empty file list is never a skip", () => {
  assert.equal(shouldSkip([]), null);
});

test("skip: check-attr failing marks nothing generated, so the file is reviewed", () => {
  const cwd = repoWith({ ".gitattributes": "dist/** linguist-generated\n" }, { "dist/out.js": "x\n" });
  const out = readGenerated({ paths: ["dist/out.js"], source: "no-such-ref", cwd });
  assert.equal(out.generated.size, 0);
  assert.match(out.error, /check-attr/);
});

// ---------- the CLI ----------

test("cli: a README-only diff exits 0 with meta.skipped and no network call, with no keys", async () => {
  const cwd = repoWith({ "README.md": "a\n" }, { "README.md": "b\n" });
  const calls = fakeFetch();
  const { result } = await withEnv({}, () => main({ argv: ["--base", "HEAD~1"], cwd }));
  assert.equal(result.code, 0);
  assert.equal(typeof result.result.meta.skipped.reason, "string");
  assert.deepEqual(calls, []);
});

test("cli: a skipped run with --post posts nothing and removes a stale notice", async () => {
  const cwd = repoWith({ "README.md": "a\n" }, { "README.md": "b\n" });
  const calls = fakeFetch({
    github: {
      "GET /repos/o/r/issues/7/comments": () =>
        new Response(JSON.stringify([{ id: 41, body: "<!-- pr-critic:no-review -->\nold" }]), { status: 200 }),
      "DELETE /repos/o/r/issues/comments/41": () => new Response(null, { status: 204 }),
    },
  });
  const { result } = await withEnv({ GITHUB_TOKEN: "t" }, () =>
    main({ argv: ["--base", "HEAD~1", "--post", "--pr", "7", "--repo", "o/r"], cwd }),
  );
  assert.equal(result.code, 0);
  assert.ok(result.result.meta.skipped);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /repos/o/r/issues/7/comments", "DELETE /repos/o/r/issues/comments/41"],
  );
});

test("cli: --no-skip reviews a README-only diff", async () => {
  const cwd = repoWith({ "README.md": "a\n" }, { "README.md": "b\n" });
  const calls = fakeFetch({ answers: { "x-ai/grok-4.3": [orReply('{"findings":[]}')] } });
  const { result } = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
    main({ argv: ["--base", "HEAD~1", "--no-skip"], cwd }),
  );
  assert.equal(result.code, 0);
  assert.equal(result.result.meta.skipped, undefined);
  assert.deepEqual(calls.map((c) => c.model), ["x-ai/grok-4.3"]);
});

test("cli: --help lists --no-skip", async () => {
  const { stdout } = await withEnv({}, () => main({ argv: ["--help"] }));
  assert.match(stdout.join("\n"), /--no-skip/);
});
