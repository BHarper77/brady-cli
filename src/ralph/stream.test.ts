import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPLETION_SIGNAL, IterationDigest } from "./stream";

test("captures the session id from the init event", () => {
  const digest = new IterationDigest(() => {});
  digest.processLine(
    JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }),
  );
  digest.processLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    }),
  );

  assert.equal(digest.sessionId, "abc-123");
});

test("keeps the first session id if a later event carries a different one", () => {
  const digest = new IterationDigest(() => {});
  digest.processLine(JSON.stringify({ type: "system", session_id: "first" }));
  digest.processLine(JSON.stringify({ type: "result", session_id: "second" }));

  assert.equal(digest.sessionId, "first");
});

test("accumulates prose text and flags the completion signal", () => {
  const digest = new IterationDigest(() => {});
  digest.processLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "working on it" }] },
    }),
  );
  digest.processLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: COMPLETION_SIGNAL }] },
    }),
  );

  assert.match(digest.text, /working on it/);
  assert.match(digest.text, /COMPLETE/);
  assert.equal(digest.completed, true);
});

test("ignores malformed lines", () => {
  const digest = new IterationDigest(() => {});
  digest.processLine("not json");
  digest.processLine("");
  assert.equal(digest.sessionId, undefined);
  assert.equal(digest.completed, false);
});

test("started is set only by the init event, not by an error result naming a session", () => {
  const failed = new IterationDigest(() => {});
  failed.processLine(
    JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "gone" }),
  );
  assert.equal(failed.started, false);
  assert.equal(failed.sessionId, "gone");

  const ok = new IterationDigest(() => {});
  ok.processLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }));
  assert.equal(ok.started, true);
});
