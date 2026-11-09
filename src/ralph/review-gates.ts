// ---------------------------------------------------------------------------
// The review loop's decisions that must not be left to an agent's say-so:
// whether triage produced usable verdicts, and whether a fix run earned the
// right to have its threads resolved. Pure, so the failure modes are testable
// without spawning anything.
// ---------------------------------------------------------------------------

export type Verdict = {
  valid: boolean;
  reason: string;
  /** Label shared by comments that need the same change. Absent: stands alone. */
  group?: string;
};

export type ParsedVerdicts =
  | { ok: true; verdicts: Map<number, Verdict>; missing: number[] }
  | { ok: false; error: string };

/**
 * Parse the triage verdicts file's contents (`undefined`: the file was never
 * written). A missing, unparseable, or shapeless file is a failed triage — the
 * caller aborts rather than guessing. Comments the file does not cover come
 * back in `missing`, for the caller to re-triage; ids it does not know are
 * ignored.
 */
export function parseVerdicts(
  raw: string | undefined,
  commentIds: number[],
): ParsedVerdicts {
  if (raw === undefined) return { ok: false, error: "triage wrote no verdicts file" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `verdicts file is not valid JSON (${String(error)})` };
  }

  const list = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) {
    return { ok: false, error: "verdicts file has no `verdicts` array" };
  }

  const wanted = new Set(commentIds);
  const verdicts = new Map<number, Verdict>();
  for (const v of list as {
    commentId?: unknown;
    valid?: unknown;
    reason?: unknown;
    group?: unknown;
  }[]) {
    if (typeof v?.commentId !== "number" || typeof v.valid !== "boolean") continue;
    if (!wanted.has(v.commentId)) continue;
    const group =
      typeof v.group === "string" && v.group.trim() !== "" ? v.group.trim() : undefined;
    verdicts.set(v.commentId, {
      valid: v.valid,
      reason: typeof v.reason === "string" ? v.reason : "",
      group,
    });
  }

  return { ok: true, verdicts, missing: commentIds.filter((id) => !verdicts.has(id)) };
}

/**
 * Comments in `ids` that gained a reply between two snapshots of the PR's
 * replies (parent comment id → reply ids). Snapshot ids rather than timestamps,
 * so local clock skew cannot make triage's earlier reply look like the fix
 * agent's.
 */
export function newlyReplied(
  before: Map<number, number[]>,
  after: Map<number, number[]>,
  ids: number[],
): Set<number> {
  const out = new Set<number>();
  for (const id of ids) {
    const seen = new Set(before.get(id) ?? []);
    if ((after.get(id) ?? []).some((reply) => !seen.has(reply))) out.add(id);
  }
  return out;
}

/**
 * Which threads of a fix group to resolve. A thread is finished business only
 * with evidence the agent acted on it: a commit landed during the run (the
 * group is one change, so the commit covers it), or the agent replied on that
 * thread. Anything else — an agent that refused, crashed, or ran out of usage —
 * stays open for a person to see.
 */
export function partitionForResolve<T extends { id: number }>(
  group: T[],
  committed: boolean,
  replied: Set<number>,
): { resolve: T[]; leaveOpen: T[] } {
  const resolve: T[] = [];
  const leaveOpen: T[] = [];
  for (const comment of group) {
    (committed || replied.has(comment.id) ? resolve : leaveOpen).push(comment);
  }
  return { resolve, leaveOpen };
}
