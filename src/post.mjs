import { commentableLines, anchor } from "./diffmap.mjs";

const MARKER = "<!-- pr-critic -->";
const NOTICE_MARKER = "<!-- pr-critic:no-review -->";
const API = "https://api.github.com";

async function request(url, { token, method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return { data: text ? JSON.parse(text) : null, link: res.headers.get("link") };
}

async function gh(path, opts) {
  return (await request(`${API}${path}`, opts)).data;
}

function nextLink(link) {
  return /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
}

// Every list endpoint defaults to 30 items, and a list read that stops at page one
// looks exactly like a short list: on a PR with 40 reviews the review just posted was
// "not on the PR". So lists are always walked to the end through the Link header,
// the only paging GitHub promises; some endpoints page by cursor.
async function* ghPages(path, { token, maxPages = Infinity } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  let url = `${API}${path}${sep}per_page=100`;
  for (let n = 0; url && n < maxPages; n++) {
    const { data, link } = await request(url, { token });
    yield data;
    url = nextLink(link);
  }
}

async function ghAll(path, opts) {
  const all = [];
  for await (const batch of ghPages(path, opts)) all.push(...batch);
  return all;
}

function severityMark(s) {
  return { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" }[s] ?? "⚪";
}

function commentBody(f) {
  return [
    `${severityMark(f.severity)} **${f.severity}** — ${f.claim}`,
    "",
    `**How it fails:** ${f.failure_scenario}`,
    f.verdict === "UNPROVEN" ? `\n_Not settled against the diff alone: ${f.refutation}_` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function summaryBody({ findings, orphans, meta }) {
  const lines = [
    MARKER,
    `**Cross-model review** — critic \`${meta.critic}\`, refuter \`${meta.refuter}\`.`,
    `${meta.raised} raised, ${meta.survived} survived refutation.`,
    "",
  ];
  if (findings.length === 0) {
    lines.push("No finding survived refutation.");
  }
  if (orphans.length) {
    lines.push("Findings that could not be anchored to a diff line:", "");
    for (const f of orphans) {
      lines.push(`- ${severityMark(f.severity)} \`${f.file}${f.line ? `:${f.line}` : ""}\` — ${f.claim}`);
      lines.push(`  - **How it fails:** ${f.failure_scenario}`);
    }
    lines.push("");
  }
  lines.push("_Advisory. Nothing here blocks a merge._");
  return lines.join("\n");
}

// GitHub returns issue comments oldest first, so on a long thread the notice is on a
// later page. Ten pages is a thousand comments; past that, a duplicate notice is a
// better outcome than an unbounded walk.
async function findNotice({ repo, pr, token }) {
  for await (const batch of ghPages(`/repos/${repo}/issues/${pr}/comments`, { token, maxPages: 10 })) {
    const hit = batch.find((c) => c.body?.includes(NOTICE_MARKER));
    if (hit) return hit;
  }
  return null;
}

// A model that answers with nothing produced a green check and a warning buried in a
// collapsed log, and the missing review went unnoticed for a day. This says so on the
// pull request itself, where the author will see it.
export async function postNoReviewNotice({ repo, pr, token, stage, models, reason }) {
  const body = [
    NOTICE_MARKER,
    "**Cross-model review did not run.**",
    "",
    `The ${stage} step failed after calling ${models.map((m) => `\`${m}\``).join(", then ")}.`,
    "",
    `Last error: ${reason}`,
    "",
    "No finding was produced, so nothing here says the change is clean. Re-run the job, or",
    "review locally with `npx github:jroehl/gh-workflows --base <base>`.",
    "",
    "_Advisory. This does not block a merge._",
  ].join("\n");

  const existing = await findNotice({ repo, pr, token });
  if (existing) {
    await gh(`/repos/${repo}/issues/comments/${existing.id}`, { token, method: "PATCH", body: { body } });
    return { id: existing.id, updated: true };
  }
  const created = await gh(`/repos/${repo}/issues/${pr}/comments`, { token, method: "POST", body: { body } });
  return { id: created.id, updated: false };
}

// Once a review lands, an old notice claiming none ran is worse than no notice.
export async function clearNoReviewNotice({ repo, pr, token }) {
  const existing = await findNotice({ repo, pr, token });
  if (!existing) return null;
  await gh(`/repos/${repo}/issues/comments/${existing.id}`, { token, method: "DELETE" });
  return existing.id;
}

export async function postReview({ repo, pr, token, diff, findings, meta }) {
  const map = commentableLines(diff);
  const inline = [];
  const orphans = [];

  for (const f of findings) {
    const line = anchor(f, map);
    if (line) inline.push({ path: f.file, line, side: "RIGHT", body: commentBody(f) });
    else orphans.push(f);
  }

  const payload = {
    event: "COMMENT",
    body: summaryBody({ findings, orphans, meta }),
    comments: inline,
  };

  let created;
  try {
    created = await gh(`/repos/${repo}/pulls/${pr}/reviews`, { token, method: "POST", body: payload });
  } catch (e) {
    // One bad anchor fails the entire review, so rather than lose every finding,
    // fall back to a summary that carries all of them as text.
    if (!/422/.test(e.message) || inline.length === 0) throw e;
    const all = { ...payload, comments: [], body: summaryBody({ findings: [], orphans: findings, meta }) };
    created = await gh(`/repos/${repo}/pulls/${pr}/reviews`, { token, method: "POST", body: all });
    return { id: created.id, inline: 0, orphans: findings.length, degraded: true };
  }

  // A 201 is not proof the review is on the PR: re-read it.
  const reviews = await ghAll(`/repos/${repo}/pulls/${pr}/reviews`, { token });
  const landed = reviews.some((r) => r.id === created.id);
  if (!landed) throw new Error(`review ${created.id} was created but is not on the PR`);

  return { id: created.id, inline: inline.length, orphans: orphans.length, degraded: false };
}
