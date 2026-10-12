import assert from "node:assert/strict";
import { scoreOutput } from "../run.mjs";

const concise = scoreOutput(
  "Read the record. Compare its version. Reject a conflict. Retry the operation.",
  { language: "en" },
);
assert.equal(concise.sentences, 4);
assert.equal(concise.longSentenceRate, 0);
assert.equal(concise.conjunctionsPerSentence, 0);
assert.equal(concise.languageMatches, true);

const dense = scoreOutput(
  "Read the record and compare its version, but reject the write when another client changed it, while preserving the new value and returning a conflict which the caller can retry after loading the latest record.",
  { language: "en" },
);
assert.equal(dense.sentences, 1);
assert.equal(dense.longSentenceRate, 1);
assert.ok(dense.conjunctionsPerSentence >= 4);

const chinese = scoreOutput(
  "客户端读取记录。客户端比较版本。版本冲突时，服务拒绝写入。客户端重新读取后重试。",
  { language: "zh" },
);
assert.equal(chinese.sentences, 4);
assert.equal(chinese.longSentenceRate, 0);
assert.equal(chinese.languageMatches, true);

const terms = scoreOutput(
  "Create one work item. The worker processes the job and completes the task.",
  { language: "en", aliases: ["work item", "job", "task"] },
);
assert.equal(terms.extraAliasesAfterNaming, 1);

const canonicalTerm = scoreOutput(
  "Use work item as the canonical term for job, task, and work item. Create the work item. Process the work item. Complete the work item.",
  { language: "en", aliases: ["work item", "job", "task"] },
);
assert.equal(canonicalTerm.extraAliasesAfterNaming, 0);

const wrongLanguage = scoreOutput("这是一个中文回答，包含足够多的中文字符，因此不应匹配英文问题。", {
  language: "en",
});
assert.equal(wrongLanguage.languageMatches, false);

const visual = scoreOutput("gateway --> auth --> cache\n                  ↓\n                reject", {
  language: "en",
  expectVisual: true,
});
assert.equal(visual.hasVisual, true);

console.log("AGENTS.md evaluation scorer tests passed");
