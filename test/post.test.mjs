import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { postReview, clearNoReviewNotice } from "../src/post.mjs";

const API = "https://api.github.com";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Pages the way GitHub does: 30 per page unless per_page says otherwise, capped at
// 100, and a Link header naming the next page while there is one.
function page(items, url) {
  const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30), 100);
  const n = Number(url.searchParams.get("page") ?? 1);
  const slice = items.slice((n - 1) * perPage, n * perPage);
  const headers = { "Content-Type": "application/json" };
  if (n * perPage < items.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(n + 1));
    headers.Link = `<${next}>; rel="next"`;
  }
  return new Response(JSON.stringify(slice), { status: 200, headers });
}

function fakeGitHub(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(url, init);
  };
  return calls;
}

const repo = "o/r";
const pr = 344;
const meta = { critic: "c", refuter: "r", raised: 0, survived: 0 };

test("postReview finds its own review past the first page of reviews", async () => {
  // PR #344 broke at 40 reviews on the default page of 30; 140 also outruns per_page=100.
  const reviews = Array.from({ length: 140 }, (_, i) => ({ id: i + 1 }));
  const calls = fakeGitHub({
    [`POST /repos/${repo}/pulls/${pr}/reviews`]: () => {
      reviews.push({ id: 141 });
      return new Response(JSON.stringify({ id: 141 }), { status: 200 });
    },
    [`GET /repos/${repo}/pulls/${pr}/reviews`]: (url) => page(reviews, url),
  });

  const posted = await postReview({ repo, pr, token: "t", diff: "", findings: [], meta });

  assert.equal(posted.id, 141);
  assert.ok(calls.some((c) => c.includes("page=2")), `expected a second page, got ${calls}`);
});

test("clearNoReviewNotice finds a notice past the first page of comments", async () => {
  const comments = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: "hi" }));
  comments.push({ id: 999, body: "<!-- pr-critic:no-review --> nothing ran" });
  const deleted = [];
  fakeGitHub({
    [`GET /repos/${repo}/issues/${pr}/comments`]: (url) => page(comments, url),
    [`DELETE /repos/${repo}/issues/comments/999`]: () => {
      deleted.push(999);
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(await clearNoReviewNotice({ repo, pr, token: "t" }), 999);
  assert.deepEqual(deleted, [999]);
});

test("pagination follows the Link header rather than guessing page numbers", async () => {
  // A server whose next link is not ?page=N+1 still has to be walked to the end.
  const calls = fakeGitHub({
    [`GET /repos/${repo}/pulls/${pr}/reviews`]: (url) => {
      const cursor = url.searchParams.get("after");
      const headers = { "Content-Type": "application/json" };
      if (!cursor) {
        headers.Link = `<${API}/repos/${repo}/pulls/${pr}/reviews?per_page=100&after=abc>; rel="next"`;
        return new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers });
      }
      return new Response(JSON.stringify([{ id: 2 }]), { status: 200, headers });
    },
    [`POST /repos/${repo}/pulls/${pr}/reviews`]: () =>
      new Response(JSON.stringify({ id: 2 }), { status: 200 }),
  });

  const posted = await postReview({ repo, pr, token: "t", diff: "", findings: [], meta });
  assert.equal(posted.id, 2);
  assert.ok(calls.some((c) => c.includes("after=abc")));
});

test("the review footer shows the run's total cost, marked when estimated", async () => {
  let posted;
  fakeGitHub({
    [`POST /repos/${repo}/pulls/${pr}/reviews`]: (url, init) => {
      posted = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    },
    [`GET /repos/${repo}/pulls/${pr}/reviews`]: (url) => page([{ id: 1 }], url),
  });
  const withCost = {
    ...meta,
    cost: { critic: 0.01, fallback: 0, refuter: 0.0234, total: 0.0334, currency: "USD", estimated: true },
  };
  await postReview({ repo, pr, token: "t", diff: "", findings: [], meta: withCost });
  assert.match(posted.body, /Cost: \$0\.0334 \(estimated\)/);
});

test("a review degraded by a 422 carries every finding and does not say none survived", async () => {
  const bodies = [];
  fakeGitHub({
    [`POST /repos/${repo}/pulls/${pr}/reviews`]: (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.comments.length) return new Response("Unprocessable: line not in diff", { status: 422 });
      return new Response(JSON.stringify({ id: 2 }), { status: 200 });
    },
  });
  const diff = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-x\n+y\n+z\n";
  const f = { file: "a.js", line: 2, severity: "high", claim: "division by zero", failure_scenario: "boom" };
  const posted = await postReview({ repo, pr, token: "t", diff, findings: [f], meta: { ...meta, raised: 1, survived: 1 } });
  assert.equal(posted.degraded, true);
  const summary = bodies.at(-1).body;
  assert.match(summary, /division by zero/);
  assert.doesNotMatch(summary, /No finding survived refutation/);
});

test("an unknown model with --post posts the config notice and exits 3 before any model call", async () => {
  const { main } = await import("../bin/pr-critic.mjs");
  const { tempRepo, withEnv } = await import("./helpers.mjs");
  const cwd = tempRepo();
  let notice;
  const calls = fakeGitHub({
    [`GET /repos/${repo}/issues/${pr}/comments`]: (url) => page([], url),
    [`POST /repos/${repo}/issues/${pr}/comments`]: (url, init) => {
      notice = JSON.parse(init.body).body;
      return new Response(JSON.stringify({ id: 9 }), { status: 201 });
    },
  });
  const argv = ["--base", "HEAD~1", "--post", "--pr", String(pr), "--repo", repo];
  argv.push("--critic-model", "openai/gpt-6.2-astra-pro");
  const { result } = await withEnv({ GITHUB_TOKEN: "t" }, () => main({ argv, cwd }));
  assert.equal(result.code, 3);
  assert.match(notice, /config step failed/);
  assert.match(notice, /not on the allowlist/);
  assert.ok(calls.every((c) => !c.includes("openrouter")), `unexpected calls: ${calls}`);
});
