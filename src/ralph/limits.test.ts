import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsageLimitMessage, limitVerdict, parseResetTime } from "./limits";
import { IterationDigest } from "./stream";

const MSG = "You've hit your 5-hour limit · resets 2:30pm (Europe/London)";
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

test("recognises the CLI's limit notices, not prose about limits", () => {
  assert.equal(isUsageLimitMessage(MSG), true);
  assert.equal(isUsageLimitMessage("You've hit your weekly limit · resets Nov 12, 9am"), true);
  assert.equal(isUsageLimitMessage("Claude AI usage limit reached|1736985600"), true);
  assert.equal(isUsageLimitMessage("The rate limit is applied per user."), false);
  assert.equal(isUsageLimitMessage("I think we hit your limit check in the test."), false);
});

test("reset time: later today in the named zone (GMT in November)", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(iso(parseResetTime(MSG, now)), "2026-11-09T14:30:00.000Z");
});

test("reset time: already passed today rolls to tomorrow", () => {
  const now = Date.parse("2026-11-09T15:00:00Z");
  assert.equal(iso(parseResetTime(MSG, now)), "2026-11-10T14:30:00.000Z");
});

test("reset time: honours daylight saving (BST in July)", () => {
  const now = Date.parse("2026-07-01T10:00:00Z");
  assert.equal(iso(parseResetTime(MSG, now)), "2026-07-01T13:30:00.000Z");
});

test("reset time: other zones and hour-only times", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(
    iso(parseResetTime("You've hit your limit · resets 9am (America/New_York)", now)),
    "2026-11-09T14:00:00.000Z",
  );
  assert.equal(
    iso(parseResetTime("You've hit your limit · resets 12am (UTC)", now)),
    "2026-11-10T00:00:00.000Z",
  );
});

test("reset time: explicit date", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(
    iso(parseResetTime("You've hit your weekly limit · resets Nov 12, 9am (UTC)", now)),
    "2026-11-12T09:00:00.000Z",
  );
});

test("reset time: epoch-seconds format", () => {
  assert.equal(
    iso(parseResetTime("Claude AI usage limit reached|1736985600", 0)),
    "2025-01-16T00:00:00.000Z",
  );
});

test("reset time: unreadable → undefined", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(parseResetTime("You've hit your 5-hour limit", now), undefined);
  assert.equal(parseResetTime("You've hit your limit · resets soon", now), undefined);
  assert.equal(parseResetTime("You've hit your limit · resets 13pm", now), undefined);
});

test("reset time: unknown zone falls back to the machine's, not a failure", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.notEqual(parseResetTime("You've hit your limit · resets 2:30pm (Mars/Olympus)", now), undefined);
});

test("limitVerdict: message means hit, with the parsed reset", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const v = limitVerdict(MSG, undefined, now);
  assert.equal(v.kind, "hit");
  assert.equal(iso(v.kind === "hit" ? v.resetsAt : undefined), "2026-11-09T14:30:00.000Z");
});

test("limitVerdict: structured resetsAt wins over the message", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const resetsAt = Date.parse("2026-11-09T14:29:00Z") / 1000;
  const v = limitVerdict(MSG, { status: "rejected", resetsAt }, now);
  assert.deepEqual(v, { kind: "hit", resetsAt: resetsAt * 1000, message: MSG });
});

test("limitVerdict: stale structured reset falls back to the message", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const v = limitVerdict(MSG, { status: "allowed", resetsAt: now / 1000 - 3600 }, now);
  assert.equal(v.kind, "hit");
  assert.equal(iso(v.kind === "hit" ? v.resetsAt : undefined), "2026-11-09T14:30:00.000Z");
});

test("limitVerdict: rejected with nothing readable → hit with no reset (caller backs off)", () => {
  assert.deepEqual(limitVerdict(undefined, { status: "rejected" }, 0), {
    kind: "hit",
    resetsAt: undefined,
    message: undefined,
  });
});

test("limitVerdict: warning and none", () => {
  const now = 1_000_000;
  assert.deepEqual(limitVerdict(undefined, { status: "allowed_warning", resetsAt: 2000 }, now), {
    kind: "warning",
    resetsAt: 2_000_000,
  });
  assert.deepEqual(limitVerdict(undefined, { status: "allowed" }, now), { kind: "none" });
  assert.deepEqual(limitVerdict(undefined, undefined, now), { kind: "none" });
});

test("digest captures the limit notice from a text block or the result", () => {
  const a = new IterationDigest(() => {});
  a.processLine(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: MSG }] } }),
  );
  assert.equal(a.limitMessage, MSG);

  const b = new IterationDigest(() => {});
  b.processLine(JSON.stringify({ type: "result", result: MSG }));
  assert.equal(b.limitMessage, MSG);

  const c = new IterationDigest(() => {});
  c.processLine(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "All done." }] } }),
  );
  assert.equal(c.limitMessage, undefined);
});
