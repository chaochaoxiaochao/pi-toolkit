export const comparisonCases = [
  {
    id: "unique-replacement",
    kind: "valid-edit",
    input: { "app.ts": "const enabled = false;\n" },
    expected: { "app.ts": "const enabled = true;\n" },
    patch: `*** Begin Patch
*** Update File: app.ts
@@
-const enabled = false;
+const enabled = true;
*** End Patch`,
    nativeCalls: [{ path: "app.ts", edits: [{ oldText: "const enabled = false;", newText: "const enabled = true;" }] }],
    outcomes: { native: "pass", released: "pass", local: "pass" },
  },
  {
    id: "disjoint-edits-one-file",
    kind: "valid-edit",
    input: { "app.ts": "const first = 1;\nconst middle = 2;\nconst last = 3;\n" },
    expected: { "app.ts": "const first = 10;\nconst middle = 2;\nconst last = 30;\n" },
    patch: `*** Begin Patch
*** Update File: app.ts
@@
-const first = 1;
+const first = 10;
@@
-const last = 3;
+const last = 30;
*** End Patch`,
    nativeCalls: [{
      path: "app.ts",
      edits: [
        { oldText: "const first = 1;", newText: "const first = 10;" },
        { oldText: "const last = 3;", newText: "const last = 30;" },
      ],
    }],
    outcomes: { native: "pass", released: "pass", local: "pass" },
  },
  {
    id: "repeated-markdown-separator",
    kind: "valid-edit",
    input: { "SKILL.md": "---\nname: demo\ndescription: old\n---\n\n# Demo\n\n---\nFooter\n" },
    expected: { "SKILL.md": "---\nname: demo\ndescription: new\n---\nInserted after frontmatter.\n\n# Demo\n\n---\nFooter\n" },
    patch: `*** Begin Patch
*** Update File: SKILL.md
@@
-description: old
+description: new
@@
 ---
+Inserted after frontmatter.
*** End Patch`,
    nativeCalls: [{ path: "SKILL.md", edits: [{ oldText: "---", newText: "---\nInserted after frontmatter." }] }],
    outcomes: { native: "fail", released: "pass", local: "pass" },
  },
  {
    id: "repeated-update-same-path",
    kind: "valid-edit",
    input: { "tool.ts": "const state = \"old\";\n" },
    expected: { "tool.ts": "const state = \"new\";\n" },
    patch: `*** Begin Patch
*** Update File: tool.ts
@@
-const state = "old";
+const state = "middle";
*** Update File: tool.ts
@@
-const state = "middle";
+const state = "new";
*** End Patch`,
    nativeCalls: [
      { path: "tool.ts", edits: [{ oldText: "const state = \"old\";", newText: "const state = \"middle\";" }] },
      { path: "tool.ts", edits: [{ oldText: "const state = \"middle\";", newText: "const state = \"new\";" }] },
    ],
    outcomes: { native: "pass", released: "fail", local: "pass" },
  },
  {
    id: "ordered-runner-type-renames",
    kind: "valid-edit",
    input: {
      "packages/herdr-subagents/src/runner.ts": `export interface TinySubagentDocument {
\tpath: string;
}

export interface TinySubagentReport {
\tdocuments: TinySubagentDocument[];
}

export interface TinySubagentOptions {
\tonUpdate?: (result: TinySubagentResult) => void;
}

export interface TinySubagentResult {
\tdocuments: TinySubagentDocument[];
\tstatus: "running" | "failed";
}

function compactText(report: TinySubagentReport): string {
\treturn report.documents.map((document) => document.path).join("\\n");
}

function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<TinySubagentResult> = {}): TinySubagentResult {
\treturn { documents: [], status: "failed", ...fields };
}

function validReport(value: unknown): value is TinySubagentReport {
\treturn Boolean(value);
}

async function readReport(path: string): Promise<TinySubagentReport | undefined> {
\treturn undefined;
}

export async function runTinySubagent(prompt: string, options: TinySubagentOptions = {}): Promise<TinySubagentResult> {
\tlet result: TinySubagentResult | undefined;
\tconst common = (): Partial<TinySubagentResult> => ({});
\tconst update = (status: TinySubagentResult["status"], summary: string) => {};
\treturn result ?? failure(".", 0, prompt, common());
}
`,
    },
    expected: {
      "packages/herdr-subagents/src/runner.ts": `export interface HerdrSubagentsDocument {
\tpath: string;
}

export interface HerdrSubagentsReport {
\tdocuments: HerdrSubagentsDocument[];
}

export interface HerdrSubagentsOptions {
\tonUpdate?: (result: HerdrSubagentsResult) => void;
}

export interface HerdrSubagentsResult {
\tdocuments: HerdrSubagentsDocument[];
\tstatus: "running" | "failed";
}

function compactText(report: HerdrSubagentsReport): string {
\treturn report.documents.map((document) => document.path).join("\\n");
}

function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<HerdrSubagentsResult> = {}): HerdrSubagentsResult {
\treturn { documents: [], status: "failed", ...fields };
}

function validReport(value: unknown): value is HerdrSubagentsReport {
\treturn Boolean(value);
}

async function readReport(path: string): Promise<HerdrSubagentsReport | undefined> {
\treturn undefined;
}

export async function runHerdrSubagents(prompt: string, options: HerdrSubagentsOptions = {}): Promise<HerdrSubagentsResult> {
\tlet result: HerdrSubagentsResult | undefined;
\tconst common = (): Partial<HerdrSubagentsResult> => ({});
\tconst update = (status: HerdrSubagentsResult["status"], summary: string) => {};
\treturn result ?? failure(".", 0, prompt, common());
}
`,
    },
    patch: `*** Begin Patch
*** Update File: packages/herdr-subagents/src/runner.ts
@@
-export interface TinySubagentDocument {
+export interface HerdrSubagentsDocument {
@@
-export interface TinySubagentReport {
+export interface HerdrSubagentsReport {
@@
-\tdocuments: TinySubagentDocument[];
+\tdocuments: HerdrSubagentsDocument[];
@@
-export interface TinySubagentOptions {
+export interface HerdrSubagentsOptions {
@@
-\tonUpdate?: (result: TinySubagentResult) => void;
+\tonUpdate?: (result: HerdrSubagentsResult) => void;
@@
-export interface TinySubagentResult {
+export interface HerdrSubagentsResult {
@@
-\tdocuments: TinySubagentDocument[];
+\tdocuments: HerdrSubagentsDocument[];
@@
-function compactText(report: TinySubagentReport): string {
+function compactText(report: HerdrSubagentsReport): string {
@@
-function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<TinySubagentResult> = {}): TinySubagentResult {
+function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<HerdrSubagentsResult> = {}): HerdrSubagentsResult {
@@
-function validReport(value: unknown): value is TinySubagentReport {
+function validReport(value: unknown): value is HerdrSubagentsReport {
@@
-async function readReport(path: string): Promise<TinySubagentReport | undefined> {
+async function readReport(path: string): Promise<HerdrSubagentsReport | undefined> {
@@
-export async function runTinySubagent(prompt: string, options: TinySubagentOptions = {}): Promise<TinySubagentResult> {
+export async function runHerdrSubagents(prompt: string, options: HerdrSubagentsOptions = {}): Promise<HerdrSubagentsResult> {
@@
-\tlet result: TinySubagentResult | undefined;
-\tconst common = (): Partial<TinySubagentResult> => ({});
+\tlet result: HerdrSubagentsResult | undefined;
+\tconst common = (): Partial<HerdrSubagentsResult> => ({});
@@
-\tconst update = (status: TinySubagentResult["status"], summary: string) => {};
+\tconst update = (status: HerdrSubagentsResult["status"], summary: string) => {};
*** End Patch`,
    nativeCalls: [{
      path: "packages/herdr-subagents/src/runner.ts",
      edits: [{
        oldText: `export interface TinySubagentDocument {
\tpath: string;
}

export interface TinySubagentReport {
\tdocuments: TinySubagentDocument[];
}

export interface TinySubagentOptions {
\tonUpdate?: (result: TinySubagentResult) => void;
}

export interface TinySubagentResult {
\tdocuments: TinySubagentDocument[];
\tstatus: "running" | "failed";
}`,
        newText: `export interface HerdrSubagentsDocument {
\tpath: string;
}

export interface HerdrSubagentsReport {
\tdocuments: HerdrSubagentsDocument[];
}

export interface HerdrSubagentsOptions {
\tonUpdate?: (result: HerdrSubagentsResult) => void;
}

export interface HerdrSubagentsResult {
\tdocuments: HerdrSubagentsDocument[];
\tstatus: "running" | "failed";
}`,
      }, {
        oldText: `function compactText(report: TinySubagentReport): string {
\treturn report.documents.map((document) => document.path).join("\\n");
}

function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<TinySubagentResult> = {}): TinySubagentResult {
\treturn { documents: [], status: "failed", ...fields };
}

function validReport(value: unknown): value is TinySubagentReport {
\treturn Boolean(value);
}

async function readReport(path: string): Promise<TinySubagentReport | undefined> {
\treturn undefined;
}

export async function runTinySubagent(prompt: string, options: TinySubagentOptions = {}): Promise<TinySubagentResult> {
\tlet result: TinySubagentResult | undefined;
\tconst common = (): Partial<TinySubagentResult> => ({});
\tconst update = (status: TinySubagentResult["status"], summary: string) => {};`,
        newText: `function compactText(report: HerdrSubagentsReport): string {
\treturn report.documents.map((document) => document.path).join("\\n");
}

function failure(cwd: string, startedAt: number, errorMessage: string, fields: Partial<HerdrSubagentsResult> = {}): HerdrSubagentsResult {
\treturn { documents: [], status: "failed", ...fields };
}

function validReport(value: unknown): value is HerdrSubagentsReport {
\treturn Boolean(value);
}

async function readReport(path: string): Promise<HerdrSubagentsReport | undefined> {
\treturn undefined;
}

export async function runHerdrSubagents(prompt: string, options: HerdrSubagentsOptions = {}): Promise<HerdrSubagentsResult> {
\tlet result: HerdrSubagentsResult | undefined;
\tconst common = (): Partial<HerdrSubagentsResult> => ({});
\tconst update = (status: HerdrSubagentsResult["status"], summary: string) => {};`,
      }],
    }],
    outcomes: { native: "pass", released: "pass", local: "pass" },
  },
  {
    id: "multi-file-add-delete-move",
    kind: "valid-edit",
    input: { "old.ts": "export const value = 1;\n", "remove.txt": "obsolete\n" },
    expected: { "new.ts": "export const value = 2;\n", "added.txt": "created\n" },
    patch: `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@
-export const value = 1;
+export const value = 2;
*** Delete File: remove.txt
*** Add File: added.txt
+created
*** End Patch`,
    nativeCalls: null,
    outcomes: { native: "unsupported", released: "pass", local: "pass" },
  },
  {
    id: "stale-expected-lines",
    kind: "safety",
    input: { "app.ts": "const actual = true;\n" },
    expected: null,
    patch: `*** Begin Patch
*** Update File: app.ts
@@
-const stale = false;
+const stale = true;
*** End Patch`,
    nativeCalls: [{ path: "app.ts", edits: [{ oldText: "const stale = false;", newText: "const stale = true;" }] }],
    outcomes: { native: "fail", released: "fail", local: "fail" },
  },
  {
    id: "conflicting-targets",
    kind: "safety",
    input: { "app.ts": "old\n" },
    expected: null,
    patch: `*** Begin Patch
*** Update File: app.ts
@@
-old
+new
*** Delete File: app.ts
*** End Patch`,
    nativeCalls: null,
    outcomes: { native: "unsupported", released: "fail", local: "fail" },
  },
  {
    id: "empty-update-chunk",
    kind: "safety",
    input: { "app.ts": "unchanged\n" },
    expected: null,
    patch: `*** Begin Patch
*** Update File: app.ts
@@
*** End Patch`,
    nativeCalls: null,
    outcomes: { native: "unsupported", released: "fail", local: "fail" },
  },
  {
    id: "resolved-path-alias-conflict",
    kind: "safety",
    input: { "app.ts": "const value = 1;\n" },
    expected: null,
    patch: `*** Begin Patch
*** Update File: app.ts
@@
-const value = 1;
+const value = 2;
*** Update File: ./app.ts
@@
-const value = 2;
+const value = 3;
*** End Patch`,
    nativeCalls: null,
    outcomes: { native: "unsupported", released: "fail", local: "fail" },
  },
  {
    id: "outside-workspace-absolute-path",
    kind: "safety",
    input: { "app.ts": "const value = 1;\n" },
    expected: null,
    patch: `*** Begin Patch
*** Update File: /tmp/outside-workspace.ts
@@
-const value = 1;
+const value = 2;
*** End Patch`,
    nativeCalls: null,
    outcomes: { native: "unsupported", released: "fail", local: "fail" },
  },
  {
    id: "bom-and-crlf",
    kind: "valid-edit",
    input: { "app.ts": "\ufeffconst old = 1;\r\nconst keep = 2;\r\n" },
    expected: { "app.ts": "\ufeffconst next = 1;\r\nconst keep = 2;\r\n" },
    patch: `*** Begin Patch
*** Update File: app.ts
@@
-const old = 1;
+const next = 1;
*** End Patch`,
    nativeCalls: [{ path: "app.ts", edits: [{ oldText: "const old = 1;", newText: "const next = 1;" }] }],
    outcomes: { native: "pass", released: "pass", local: "pass" },
  },
];
