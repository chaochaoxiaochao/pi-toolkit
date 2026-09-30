import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyUpdate, parsePatch, resolveWorkspacePath } from "../src/parser.ts";

test("parses add, delete, update, and move operations", () => {
  const operations = parsePatch(`*** Begin Patch
*** Add File: added.txt
+hello
*** Delete File: removed.txt
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new
*** End Patch`);
  assert.deepEqual(operations.map((operation) => operation.action), ["add", "delete", "update"]);
  assert.equal(operations[0].content, "hello\n");
  assert.equal(operations[2].moveTo, "new.txt");
  assert.deepEqual(operations[2].chunks[0].oldLines, ["old"]);
  assert.deepEqual(operations[2].chunks[0].newLines, ["new"]);
});

test("rejects malformed patches and duplicate targets", () => {
  assert.throws(() => parsePatch("bad"), /first line/);
  assert.throws(() => parsePatch(`*** Begin Patch
*** Add File: same.txt
+x
*** Add File: same.txt
+y
*** End Patch`), /same path/);
});

test("applies multiple chunks using context and preserves BOM and CRLF", () => {
  const before = "\ufefffunction run() {\r\n  const value = 1;\r\n  return value;\r\n}\r\n";
  const operations = parsePatch(`*** Begin Patch
*** Update File: src/run.js
@@ function run() {
-  const value = 1;
+  const value = 2;
@@
-  return value;
+  return value + 1;
*** End Patch`);
  const after = applyUpdate(before, operations[0].chunks, "src/run.js");
  assert.equal(after, "\ufefffunction run() {\r\n  const value = 2;\r\n  return value + 1;\r\n}\r\n");
});

test("supports insertion chunks and EOF matching", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: file.txt
@@
+first
*** End of File
*** End Patch`);
  assert.equal(applyUpdate("", operations[0].chunks, "file.txt"), "first\n");
});

test("uses the first matching region at or after the cursor", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: file.txt
@@
-value
+changed
*** End Patch`);
  assert.equal(applyUpdate("value\nvalue\n", operations[0].chunks, "file.txt"), "changed\nvalue\n");
});

test("uses earlier hunks to advance the cursor through repeated HTML regions", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: page.html
@@
-old
+new
@@
 </section>
+<section id="inserted"></section>
 <section>
*** End Patch`);
  const before = `<header>
old
</header>
<section>first</section>
</section>
<section>
one
</section>
<section>
two
</section>
`;
  const after = `<header>
new
</header>
<section>first</section>
</section>
<section id="inserted"></section>
<section>
one
</section>
<section>
two
</section>
`;
  assert.equal(applyUpdate(before, operations[0].chunks, "page.html"), after);
});

test("applies a hunk at the first repeated Markdown separator after its cursor", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: SKILL.md
@@
-description: old
+description: new
@@
 ---
+Inserted after frontmatter.
*** End Patch`);
  const before = `---
name: demo
description: old
---

# Demo

---
Footer
`;
  const after = `---
name: demo
description: new
---
Inserted after frontmatter.

# Demo

---
Footer
`;
  assert.equal(applyUpdate(before, operations[0].chunks, "SKILL.md"), after);
});

test("parses multiple file operations used by structural refactors", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: extensions/tool.ts
*** Move to: packages/tool/extensions/tool.ts
@@
-export const value = 1;
+export const value = 2;
*** Add File: extensions/tool-wrapper.ts
+export { value } from "../packages/tool/extensions/tool.ts";
*** Delete File: extensions/tool.test.ts
*** End Patch`);
  assert.deepEqual(
    operations.map(({ action, path, moveTo }) => ({ action, path, moveTo })),
    [
      { action: "update", path: "extensions/tool.ts", moveTo: "packages/tool/extensions/tool.ts" },
      { action: "add", path: "extensions/tool-wrapper.ts", moveTo: undefined },
      { action: "delete", path: "extensions/tool.test.ts", moveTo: undefined },
    ],
  );
});

test("rejects workspace escapes", () => {
  assert.equal(resolveWorkspacePath("/tmp/project", "/tmp/project/src/a.js"), "/tmp/project/src/a.js");
  assert.throws(() => resolveWorkspacePath("/tmp/project", "/tmp/other/a.js"), /escapes/);
});

test("round-trips a temporary file operation fixture", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "codex-edit-test-"));
  try {
    const path = join(workspace, "file.txt");
    await writeFile(path, "before\n", "utf8");
    const operations = parsePatch(`*** Begin Patch
*** Update File: file.txt
@@
-before
+after
*** End Patch`);
    await writeFile(path, applyUpdate(await readFile(path, "utf8"), operations[0].chunks, "file.txt"), "utf8");
    assert.equal(await readFile(path, "utf8"), "after\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
