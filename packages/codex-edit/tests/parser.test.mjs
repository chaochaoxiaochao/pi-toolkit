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

test("rejects ambiguous matches and workspace escapes", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: file.txt
@@
-value
+changed
*** End Patch`);
  assert.throws(() => applyUpdate("value\nvalue\n", operations[0].chunks, "file.txt"), /Ambiguous/);
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
