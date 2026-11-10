// ---------------------------------------------------------------------------
// Reading the PR-body agent's reply. Pure, apart from pr.ts so it can be
// tested without loading the prompt.
// ---------------------------------------------------------------------------

export type PrDraft = { title: string; body: string };

/**
 * Read the agent's `<title>…</title><body>…</body>` reply. Undefined when
 * either part is missing or empty. Adds `Closes #<issue>` if the body does not
 * already close the parent issue.
 */
export function parsePrDraft(text: string, parentIssue: number): PrDraft | undefined {
  const title = lastMatch(text, /<title>([\s\S]*?)<\/title>/g)?.replace(/\s+/g, " ").trim();
  let body = lastMatch(text, /<body>([\s\S]*?)<\/body>/g)?.trim();
  if (!title || !body) return undefined;

  const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${parentIssue}\\b`, "i");
  if (!closes.test(body)) body += `\n\nCloses #${parentIssue}`;
  return { title, body };
}

/** The last capture of `re` in `text`: the agent may quote the format earlier on. */
function lastMatch(text: string, re: RegExp): string | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last;
}
