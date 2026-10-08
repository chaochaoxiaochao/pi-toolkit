import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyUpdate, applyUpdateGroups, parsePatch, resolveWorkspacePath } from "../src/parser.ts";

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

test("coalesces repeated updates to one path and preserves operation order", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: src/tool.ts
@@
-const value = 1;
+const value = 2;
*** Update File: src/tool.ts
@@
-const value = 2;
+const value = 3;
*** End Patch`);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].path, "src/tool.ts");
  assert.equal(operations[0].chunkGroups.length, 2);
  const after = applyUpdateGroups("const value = 1;\n", operations[0].chunkGroups, "src/tool.ts");
  assert.equal(after, "const value = 3;\n");
});

test("still rejects conflicting repeated targets", () => {
  assert.throws(() => parsePatch(`*** Begin Patch
*** Update File: src/tool.ts
@@
-old
+new
*** Delete File: src/tool.ts
*** End Patch`), /same path/);
  assert.throws(() => parsePatch(`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-old
+new
*** Add File: src/new.ts
+replacement
*** End Patch`), /same path/);
});

test("rejects empty chunks and stale expected lines instead of guessing", () => {
  assert.throws(() => parsePatch(`*** Begin Patch
*** Update File: src/tool.ts
@@
*** End Patch`), /Empty update chunk/);
  const [operation] = parsePatch(`*** Begin Patch
*** Update File: src/tool.ts
@@
-missing line
+replacement
*** End Patch`);
  assert.throws(
    () => applyUpdate("actual line\n", operation.chunks, operation.path),
    /Failed to find expected lines in src\/tool\.ts/,
  );
});

test("handles the reported project-scale repeated-file and Markdown shapes", () => {
  const operations = parsePatch(`*** Begin Patch
*** Update File: skills/pi-worktree/SKILL.md
@@
-description: old
+description: updated
@@
 ---
+Release notes follow.
*** Update File: packages/tiny-subagent/src/tool.ts
@@
-const state = "old";
+const state = "middle";
*** Update File: packages/tiny-subagent/src/tool.ts
@@
-const state = "middle";
+const state = "new";
*** Update File: scripts/release-package.sh
@@
-ROOT_LEVEL=patch
+ROOT_LEVEL=minor
*** Update File: scripts/release-package.sh
@@
-ROOT_LEVEL=minor
+ROOT_LEVEL=patch
*** End Patch`);
  assert.deepEqual(operations.map((operation) => operation.path), [
    "skills/pi-worktree/SKILL.md",
    "packages/tiny-subagent/src/tool.ts",
    "scripts/release-package.sh",
  ]);
  assert.equal(operations[1].chunkGroups.length, 2);
  assert.equal(operations[2].chunkGroups.length, 2);

  const skill = `---
name: pi-worktree
description: old
---

# pi-worktree

---
Footer
`;
  assert.equal(
    applyUpdateGroups(skill, operations[0].chunkGroups, operations[0].path),
    `---
name: pi-worktree
description: updated
---
Release notes follow.

# pi-worktree

---
Footer
`,
  );
  assert.equal(
    applyUpdateGroups('const state = "old";\n', operations[1].chunkGroups, operations[1].path),
    'const state = "new";\n',
  );
  assert.equal(
    applyUpdateGroups("ROOT_LEVEL=patch\n", operations[2].chunkGroups, operations[2].path),
    "ROOT_LEVEL=patch\n",
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
