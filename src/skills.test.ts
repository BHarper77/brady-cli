import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSkill, stripFrontmatter } from "./skills";

test("stripFrontmatter drops the YAML block, LF or CRLF", () => {
  assert.equal(stripFrontmatter("---\nname: x\ndisable-model-invocation: true\n---\n\n# Body\n"), "# Body");
  assert.equal(stripFrontmatter("---\r\nname: x\r\n---\r\n# Body\r\n"), "# Body");
  assert.equal(stripFrontmatter("# No frontmatter"), "# No frontmatter");
});

test("loadSkill reads the body from the target repo, and rejects an empty one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brady-skills-test-"));
  const skills = path.join(dir, ".claude", "skills");
  fs.mkdirSync(path.join(skills, "good"), { recursive: true });
  fs.writeFileSync(path.join(skills, "good", "SKILL.md"), "---\nname: good\n---\n# Do it\n");
  fs.mkdirSync(path.join(skills, "empty"), { recursive: true });
  fs.writeFileSync(path.join(skills, "empty", "SKILL.md"), "---\nname: empty\n---\n");

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const good = loadSkill("good");
    assert.equal(good?.body, "# Do it");
    assert.equal(good?.dir, path.join(skills, "good"));
    assert.equal(loadSkill("empty"), undefined);
    assert.equal(loadSkill("brady-test-no-such-skill"), undefined);
  } finally {
    process.chdir(cwd);
  }
});
