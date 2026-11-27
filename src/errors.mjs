// What an empty answer is said to be. Which of the two it was decides whether raising
// the budget would help, and this message is what the pull request comment quotes.
export function emptyAnswer(model, truncated, reason, maxTokens) {
  const why = truncated
    ? `it used the whole ${maxTokens}-token budget on reasoning and was cut off`
    : `finish_reason ${reason ?? "unknown"}`;
  const err = new Error(`${model} returned no content: ${why}`);
  err.code = "empty";
  return err;
}

export function transportError(transport, code, message) {
  const err = new Error(message);
  err.transport = transport;
  err.code = code;
  return err;
}

// A response body is quoted into errors, which reach logs and the pull request. The
// direct APIs do not echo the key, but a proxy in between might, so anything that looks
// like one is cut out before the text goes anywhere.
export function redact(text) {
  return String(text).replace(/\b(sk|key)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]");
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
  const err = new Error(`Model did not return parsable JSON: ${text.slice(0, 300)}`);
  err.code = "parse";
  throw err;
}
