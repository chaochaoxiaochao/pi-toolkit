import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLEAR_OUTPUT = `## Clear Output

- Use ASD-STE100-inspired principles: short sentences, one idea per sentence, and consistent terms. Apply its formal language rules only to English.
- When it improves understanding, use a diagram, HTML artifact, or video instead of long prose.`;

const BASE_SYSTEM = "You are an expert coding assistant. Give a direct and accurate answer. Reply in the same language as the user.";

export const variants = {
  before: BASE_SYSTEM,
  after: `${BASE_SYSTEM}\n\n${CLEAR_OUTPUT}`,
};

export const cases = [
  {
    id: "english-explanation",
    language: "en",
    prompt: "Explain how optimistic concurrency control prevents lost updates. Include the read, write, conflict, and retry stages. Write for an application developer.",
  },
  {
    id: "chinese-explanation",
    language: "zh",
    prompt: "向应用开发者解释乐观并发控制如何防止更新丢失。需要涵盖读取、写入、冲突和重试阶段。",
  },
  {
    id: "term-consistency",
    language: "en",
    aliases: ["work item", "job", "task"],
    prompt: "A queue API uses job, task, and work item for the same object. Explain its lifecycle from creation through processing to completion. Resolve the naming ambiguity in your answer.",
  },
  {
    id: "visual-flow",
    language: "en",
    expectVisual: true,
    prompt: "Explain this request flow: gateway to authentication; failed authentication to rejection; successful authentication to cache; cache miss to database; transient database failure retries twice, then returns an error. Make the branching and retry path easy to verify.",
  },
];

function splitSentences(text) {
  return [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
}

function tokenCount(sentence, language) {
  if (language === "zh") {
    return (sentence.match(/[\p{Script=Han}]|[A-Za-z0-9]+/gu) ?? []).length;
  }
  return (sentence.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? []).length;
}

export function scoreOutput(text, testCase) {
  const sentences = splitSentences(text);
  const lengths = sentences.map((sentence) => tokenCount(sentence, testCase.language));
  const limit = testCase.language === "zh" ? 35 : 25;
  const conjunctionPattern = testCase.language === "zh"
    ? /(?:而且|但是|同时|以及|并且|然而|其中)/g
    : /\b(?:and|but|while|whereas|which|although|however)\b/gi;
  const conjunctions = sentences.reduce(
    (sum, sentence) => sum + (sentence.match(conjunctionPattern) ?? []).length,
    0,
  );
  const firstParagraphEnd = text.indexOf("\n\n");
  const bodyAfterNaming = firstParagraphEnd >= 0
    ? text.slice(firstParagraphEnd + 2)
    : sentences.slice(1).join(" ");
  const usedAliasesAfterNaming = (testCase.aliases ?? []).filter((alias) =>
    new RegExp(`\\b${alias.replaceAll(" ", "\\s+")}s?\\b`, "i").test(bodyAfterNaming),
  );
  const hasVisual = /```(?:mermaid)?|(?:-->|->|→|↓|├|└)|<svg\b|<html\b|\|[^\n]+\|[^\n]+\|/i.test(text);
  const hanCharacters = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const latinWords = (text.match(/[A-Za-z]+/g) ?? []).length;
  const languageMatches = testCase.language === "zh"
    ? hanCharacters >= 20
    : hanCharacters <= Math.max(5, latinWords * 0.05);

  return {
    characters: text.length,
    sentences: sentences.length,
    averageSentenceTokens: lengths.length
      ? Number((lengths.reduce((sum, value) => sum + value, 0) / lengths.length).toFixed(1))
      : 0,
    longSentenceRate: lengths.length
      ? Number((lengths.filter((value) => value > limit).length / lengths.length).toFixed(2))
      : 0,
    conjunctionsPerSentence: lengths.length
      ? Number((conjunctions / lengths.length).toFixed(2))
      : 0,
    extraAliasesAfterNaming: Math.max(0, usedAliasesAfterNaming.length - 1),
    languageMatches,
    hasVisual,
  };
}

function parseArguments(argv) {
  const options = { runs: 1, model: process.env.PI_EVAL_MODEL };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--runs") options.runs = Number(argv[++index]);
    else if (argv[index] === "--model") options.model = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return options;
}

function runPi(systemPrompt, prompt, model) {
  const args = [
    "--print",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--system-prompt",
    systemPrompt,
  ];
  if (model) args.push("--model", model);
  args.push("--", prompt);
  return execFileSync("pi", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function average(rows, key) {
  if (rows.length === 0) return 0;
  return Number((rows.reduce((sum, row) => sum + Number(row.score[key]), 0) / rows.length).toFixed(2));
}

export function summarize(results) {
  return Object.fromEntries(Object.keys(variants).map((variant) => {
    const rows = results.filter((result) => result.variant === variant);
    const visualRows = rows.filter((result) => cases.find(({ id }) => id === result.caseId).expectVisual);
    const terminologyRows = rows.filter((result) => cases.find(({ id }) => id === result.caseId).aliases);
    return [variant, {
      averageCharacters: average(rows, "characters"),
      averageSentenceTokens: average(rows, "averageSentenceTokens"),
      longSentenceRate: average(rows, "longSentenceRate"),
      conjunctionsPerSentence: average(rows, "conjunctionsPerSentence"),
      languageMatchRate: average(rows, "languageMatches"),
      visualFlowRate: average(visualRows, "hasVisual"),
      extraAliasesAfterNaming: average(terminologyRows, "extraAliasesAfterNaming"),
    }];
  }));
}

export function markdownReport(payload) {
  const { summary } = payload;
  const lines = [
    "# AGENTS.md Clear Output A/B Evaluation",
    "",
    `Runs per case: ${payload.options.runs}`,
    `Model override: ${payload.options.model ?? "Pi default"}`,
    "",
    "| Variant | Mean characters | Mean sentence tokens | Long sentence rate | Conjunctions / sentence | Language match | Visual-flow rate | Extra aliases |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(summary).map(([name, score]) =>
      `| ${name} | ${score.averageCharacters} | ${score.averageSentenceTokens} | ${score.longSentenceRate} | ${score.conjunctionsPerSentence} | ${score.languageMatchRate} | ${score.visualFlowRate} | ${score.extraAliasesAfterNaming} |`,
    ),
    "",
    "Lower is better for long sentence rate, conjunctions, and extra aliases after naming. Higher is better for language match and visual-flow rate. Character count is descriptive, not a quality score.",
    "",
    "## Per-case output",
    "",
    ...payload.results.flatMap((result) => [
      `### ${result.caseId} · ${result.variant} · run ${result.run}`,
      "",
      `Score: \`${JSON.stringify(result.score)}\``,
      "",
      result.output,
      "",
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const results = [];
  for (let run = 1; run <= options.runs; run += 1) {
    for (const testCase of cases) {
      const order = run % 2 === 1 ? ["before", "after"] : ["after", "before"];
      for (const variant of order) {
        process.stderr.write(`Running ${testCase.id} / ${variant} / ${run}\n`);
        const output = runPi(variants[variant], testCase.prompt, options.model);
        results.push({
          caseId: testCase.id,
          variant,
          run,
          output,
          score: scoreOutput(output, testCase),
        });
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    options,
    summary: summarize(results),
    results,
  };
  const resultDirectory = fileURLToPath(new URL("./results", import.meta.url));
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(`${resultDirectory}/latest.json`, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(`${resultDirectory}/latest.md`, markdownReport(payload));
  console.log(JSON.stringify(payload.summary, null, 2));
  console.log(`\nFull report: ${resultDirectory}/latest.md`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
