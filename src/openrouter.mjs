const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// Reasoning models degrade when pinned to temperature 0, so temperature is never
// sent and the model's own default stands.
//
// The budget is shared with reasoning tokens. At 8000, gpt-5.1-codex spent the whole
// allowance thinking, was cut off before writing a character, and returned an empty
// string that read exactly like a clean review. OpenRouter bills tokens actually
// produced, so a ceiling this high costs nothing until something needs it.
export async function complete({ model, system, user, maxTokens = 32_000 }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "pr-critic",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    const err = new Error(`OpenRouter ${res.status}: ${body}`);
    // Out of credit or a dead key is not a transient hiccup: it means no review
    // will ever run again until someone acts. Tagged so the caller can be loud
    // about it instead of passing green with a warning nobody reads.
    if (res.status === 401 || res.status === 402 || res.status === 403) err.fatal = true;
    throw err;
  }
  const body = await res.json();
  const choice = body.choices?.[0];
  const text = choice?.message?.content;
  if (!text) {
    // Which of the two it was decides whether raising the budget would help, and
    // this message is what the pull request comment ends up quoting.
    const why =
      choice?.finish_reason === "length"
        ? `it used the whole ${maxTokens}-token budget on reasoning and was cut off`
        : `finish_reason ${choice?.finish_reason ?? "unknown"}`;
    throw new Error(`${model} returned no content: ${why}`);
  }
  return { text, usage: body.usage ?? {}, model: body.model ?? model };
}

// Models wrap JSON in prose or fences often enough that a bare JSON.parse loses
// whole runs. Fall back to the outermost brace-delimited span.
export function parseJson(text) {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ];
  for (const a of attempts) {
    try {
      return JSON.parse(a.trim());
    } catch {
      /* next */
    }
  }
  throw new Error(`Model did not return parsable JSON: ${text.slice(0, 300)}`);
}
