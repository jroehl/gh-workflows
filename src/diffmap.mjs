// GitHub rejects a review comment whose line is not part of the pull request's
// diff, and it rejects the WHOLE review, not the offending comment. So every
// anchor is checked against the hunks before anything is posted.
export function commentableLines(diff) {
  const byFile = new Map();
  let file = null;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(raw);
    if (fileMatch) {
      file = fileMatch[1];
      if (!byFile.has(file)) byFile.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;

    // Added and context lines both exist on the RIGHT side and both accept a
    // comment; a removed line has no new-file line number, so it cannot.
    if (raw.startsWith("+") || raw.startsWith(" ")) byFile.get(file).add(newLine++);
    else if (raw.startsWith("-")) continue;
  }
  return byFile;
}

export function anchor(finding, map) {
  const lines = map.get(finding.file);
  if (!lines || lines.size === 0) return null;
  if (finding.line && lines.has(Number(finding.line))) return Number(finding.line);
  return null;
}
