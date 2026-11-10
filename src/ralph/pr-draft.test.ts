import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePrDraft } from "./pr-draft";

test("parsePrDraft: reads title and body, keeps an existing Closes line", () => {
  const draft = parsePrDraft(
    "Looked at the commits.\n<title>feat: rebuild\n transactions</title>\n<body>\nDoes things.\n\nCloses #371\n</body>",
    371,
  );
  assert.deepEqual(draft, { title: "feat: rebuild transactions", body: "Does things.\n\nCloses #371" });
});

test("parsePrDraft: appends Closes when the body does not close the parent", () => {
  const draft = parsePrDraft("<title>fix: x</title><body>Refs #12</body>", 371);
  assert.equal(draft?.body, "Refs #12\n\nCloses #371");
});

test("parsePrDraft: uses the last block when the format is quoted earlier", () => {
  const draft = parsePrDraft(
    "<title>the title</title><body>the body</body> … <title>feat: real</title><body>Real. Fixes #5</body>",
    5,
  );
  assert.deepEqual(draft, { title: "feat: real", body: "Real. Fixes #5" });
});

test("parsePrDraft: missing or empty parts → undefined", () => {
  assert.equal(parsePrDraft("no tags", 1), undefined);
  assert.equal(parsePrDraft("<title>t</title><body>  </body>", 1), undefined);
  assert.equal(parsePrDraft("<title> </title><body>b</body>", 1), undefined);
});
