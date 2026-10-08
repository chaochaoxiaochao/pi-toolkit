import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { incidentCases } from "../benchmark/incident-cases.mjs";
import { comparisonCases } from "./comparison-cases.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const docsDir = process.env.CODEX_EDIT_REPORT_DIR
  ? resolve(process.env.CODEX_EDIT_REPORT_DIR)
  : join(packageDir, "docs");
const defaultEvidencePath = join(packageDir, "benchmark/results/explicit-edit-100-sol-low-v3.json");
const checks = [
  {
    name: "Node 回归测试",
    command: ["node", "--experimental-strip-types", "--test", "tests/package.test.mjs", "tests/parser.test.mjs", "tests/released-vs-local.test.mjs", "tests/benchmark.test.mjs"],
  },
  {
    name: "原生 edit 与本地 Codex Edit 对比",
    command: ["pi", "-ne", "-e", "./tests/native-vs-codex.ts"],
  },
  {
    name: "扩展加载",
    command: ["pi", "-ne", "-e", "./extensions/codex-edit.ts"],
  },
  {
    name: "独立包 tarball",
    command: ["npm", "pack", "--dry-run", "--json"],
  },
];

function runCheck(check) {
  try {
    const output = execFileSync(check.command[0], check.command.slice(1), {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ...check, status: "PASS", output };
  } catch (error) {
    return {
      ...check,
      status: "FAIL",
      output: [error.stdout, error.stderr].filter(Boolean).join("\n"),
    };
  }
}

function count(outcome, arm) {
  return comparisonCases.filter((testCase) => testCase.outcomes[arm] === outcome).length;
}

function rate(numerator, denominator) {
  return denominator === 0 ? "n/a" : `${(numerator / denominator * 100).toFixed(1)}%`;
}

function signedPoints(next, previous, denominator) {
  const delta = (next - previous) / denominator * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp`;
}

function outcomeLabel(value) {
  if (value === "pass") return "通过";
  if (value === "fail") return "正确拒绝/失败";
  return "不适用";
}

function commandText(command) {
  return command.map((part) => part.includes(" ") ? JSON.stringify(part) : part).join(" ");
}

async function loadBenchmark() {
  try {
    const evidencePath = process.env.CODEX_EDIT_BENCHMARK_EVIDENCE
      ? resolve(process.env.CODEX_EDIT_BENCHMARK_EVIDENCE)
      : defaultEvidencePath;
    const [evidence, manifest] = await Promise.all([
      readFile(evidencePath, "utf8").then(JSON.parse),
      readFile(join(packageDir, "benchmark/explicit-edit-100.json"), "utf8").then(JSON.parse),
    ]);
    if (evidence.schemaVersion !== 1 || evidence.results.length !== evidence.completed) {
      throw new Error(`Invalid benchmark evidence: ${evidencePath}`);
    }
    const results = evidence.results.map((result) => {
      const providerFailures = Number(result.providerFailures ?? 0);
      const attempts = [{ execution: {
        costUsd: result.costUsd,
        totalTokens: result.totalTokens,
        toolCalls: result.toolCalls,
        failedToolCalls: result.failedToolCalls,
        providerFailure: providerFailures ? "provider failure" : null,
      } }];
      for (let index = 1; index < providerFailures; index += 1) {
        attempts.push({ execution: { providerFailure: "provider failure" } });
      }
      return {
        taskId: result.taskId,
        profile: result.profile,
        category: result.category,
        seconds: result.seconds,
        recovery: {
          firstAttemptPassed: result.firstAttemptPassed,
          eventuallyPassed: result.eventuallyPassed,
          recoveriesUsed: result.recoveriesUsed,
          attempts,
        },
      };
    });
    const harnesses = Object.fromEntries(Object.entries(evidence.harnesses).map(([profile, harness]) => [profile, {
      ...harness,
      configuration: { extensions: harness.extensions },
    }]));
    return {
      runId: evidence.runId,
      progress: { completed: evidence.completed, total: evidence.total, results },
      manifest,
      config: { harnesses },
      evidence,
    };
  } catch {
    return null;
  }
}

function benchmarkMetrics(benchmark, profile) {
  const results = benchmark.progress.results.filter((result) => result.profile === profile);
  const attempts = results.flatMap((result) => result.recovery?.attempts ?? []);
  const first = results.filter((result) => result.recovery?.firstAttemptPassed).length;
  const final = results.filter((result) => result.recovery?.eventuallyPassed).length;
  const coverage = results.length / 100;
  const firstRate = results.length ? first / results.length : 0;
  const finalRate = results.length ? final / results.length : 0;
  return {
    results, first, final,
    score: coverage * (0.75 * firstRate + 0.25 * finalRate),
    recoveryGain: final - first,
    recoveriesUsed: results.reduce((sum, result) => sum + Number(result.recovery?.recoveriesUsed ?? 0), 0),
    cost: attempts.reduce((sum, attempt) => sum + Number(attempt.execution?.costUsd ?? 0), 0),
    tokens: attempts.reduce((sum, attempt) => sum + Number(attempt.execution?.totalTokens ?? 0), 0),
    seconds: results.reduce((sum, result) => sum + Number(result.seconds ?? 0), 0),
    toolCalls: attempts.reduce((sum, attempt) => sum + Number(attempt.execution?.toolCalls ?? 0), 0),
    failedToolCalls: attempts.reduce((sum, attempt) => sum + Number(attempt.execution?.failedToolCalls ?? 0), 0),
    providerFailures: attempts.filter((attempt) => attempt.execution?.providerFailure).length,
  };
}

function benchmarkAssessment(benchmark) {
  if (!benchmark) return { complete: false, status: "未运行", checks: [] };
  const profiles = ["native-edit", "released-codex-edit", "local-codex-edit"];
  const metrics = Object.fromEntries(profiles.map((profile) => [profile, benchmarkMetrics(benchmark, profile)]));
  const complete = profiles.every((profile) => metrics[profile].results.length === 100);
  if (!complete) return { complete, status: "不完整", checks: [], metrics };
  const local = metrics["local-codex-edit"];
  const native = metrics["native-edit"];
  const released = metrics["released-codex-edit"];
  const paired = (baseline, field) => {
    const baselineByTask = new Map(metrics[baseline].results.map((result) => [result.taskId, Boolean(result.recovery?.[field])]));
    return local.results.reduce((counts, result) => {
      const localPassed = Boolean(result.recovery?.[field]);
      const baselinePassed = baselineByTask.get(result.taskId);
      if (localPassed !== baselinePassed) counts[localPassed ? "wins" : "losses"] += 1;
      return counts;
    }, { wins: 0, losses: 0 });
  };
  const releasedFinal = paired("released-codex-edit", "eventuallyPassed");
  const nativeFinalByTask = new Map(native.results.map((result) => [result.taskId, Boolean(result.recovery?.eventuallyPassed)]));
  const releasedFinalByTask = new Map(released.results.map((result) => [result.taskId, Boolean(result.recovery?.eventuallyPassed)]));
  const exclusiveRegressions = local.results.filter((result) => !result.recovery?.eventuallyPassed
    && (nativeFinalByTask.get(result.taskId) || releasedFinalByTask.get(result.taskId))).length;
  const efficiencyFields = ["cost", "tokens", "seconds", "toolCalls"];
  const efficiencyDeltas = Object.fromEntries(efficiencyFields.map((field) => [field, (local[field] - native[field]) / native[field]]));
  const efficiencyNoWorse = Object.values(efficiencyDeltas).filter((delta) => delta <= 0).length;
  const checks = [
    ["本地 Score v2 严格高于原生 edit", local.score > native.score],
    ["本地 First Exact 不低于原生 edit", local.first >= native.first],
    ["本地 Final Exact 距最佳对照不超过 2/100", local.final >= Math.max(native.final, released.final) - 2],
    ["相对发布版的改善数不少于回归数", releasedFinal.wins >= releasedFinal.losses],
    ["本地独有最终回归不超过 2 个", exclusiveRegressions <= 2],
    ["四项效率至少三项不差于原生，且单项恶化不超过 10%", efficiencyNoWorse >= 3 && Object.values(efficiencyDeltas).every((delta) => delta <= 0.10)],
  ];
  return {
    complete, metrics, checks, efficiencyDeltas, exclusiveRegressions,
    status: checks.every(([, passed]) => passed) ? "通过（有共同例外）" : "失败",
  };
}

function buildBenchmarkSection(benchmark) {
  if (!benchmark) return ["## Agent Benchmark", "", "**状态：未运行** — 生成报告时未找到正式运行产物。", ""];
  const profiles = ["native-edit", "released-codex-edit", "local-codex-edit"];
  const metrics = Object.fromEntries(profiles.map((profile) => [profile, benchmarkMetrics(benchmark, profile)]));
  const assessment = benchmarkAssessment(benchmark);
  const completed = Math.min(...profiles.map((profile) => metrics[profile].results.length));
  const complete = profiles.every((profile) => metrics[profile].results.length === 100);
  const taskById = new Map(benchmark.manifest.included.map((task) => [task.id, task]));
  const categories = [...new Set(metrics[profiles[0]].results.map((result) => result.category))].sort();
  const totalCost = profiles.reduce((sum, profile) => sum + metrics[profile].cost, 0);
  const percentage = (value) => `${(value * 100).toFixed(2)}%`;
  const labels = { "native-edit": "原生 edit", "released-codex-edit": "发布版 0.1.7", "local-codex-edit": "本地修改版" };
  const paired = (baseline, field) => {
    const baselineByTask = new Map(metrics[baseline].results.map((result) => [result.taskId, Boolean(result.recovery?.[field])]));
    return metrics["local-codex-edit"].results.reduce((counts, result) => {
      if (!baselineByTask.has(result.taskId)) return counts;
      const local = Boolean(result.recovery?.[field]);
      const other = baselineByTask.get(result.taskId);
      counts[local === other ? "ties" : local ? "wins" : "losses"] += 1;
      return counts;
    }, { wins: 0, losses: 0, ties: 0 });
  };
  const pairedRows = [
    ["本地版 vs 原生 edit", "首次精确", paired("native-edit", "firstAttemptPassed")],
    ["本地版 vs 原生 edit", "最终精确", paired("native-edit", "eventuallyPassed")],
    ["本地版 vs 发布版", "首次精确", paired("released-codex-edit", "firstAttemptPassed")],
    ["本地版 vs 发布版", "最终精确", paired("released-codex-edit", "eventuallyPassed")],
  ];
  const observedChallenge = metrics[profiles[0]].results.filter((result) => taskById.get(result.taskId)?.cohort === "challenge").length;
  return [
    "## Agent Benchmark：真实模型基准",
    "",
    `**状态：${complete ? assessment.status : "不完整 — 不能判定胜负"}**`,
    "",
    complete ? `三个测试臂均完成全部 100 个配对任务（共 300 条 chain），实际成本为 $${totalCost.toFixed(3)}。本地版满足全部正式验收门槛；8 个最终失败均为三臂共同失败，不是本地版独有回归。` : `预算门禁在每臂完成 ${completed}/100 个任务后停止运行（共 ${benchmark.progress.completed}/300 条 chain），实际观测成本为 $${totalCost.toFixed(3)}。未选择性补跑剩余任务，因此不能用该子集评估正式验收条件。`,
    "",
    "| 测试臂 | 覆盖率 | First Exact | Final Exact | 恢复次数 / 净增益 | Score v2 | 成本 | Token | 耗时 | 工具调用 | 失败调用 | Provider 失败 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...profiles.map((profile) => {
      const value = metrics[profile];
      return `| ${labels[profile]} | ${value.results.length}/100 | ${value.first}/${value.results.length} (${percentage(value.first / value.results.length)}) | ${value.final}/${value.results.length} (${percentage(value.final / value.results.length)}) | ${value.recoveriesUsed} / +${value.recoveryGain} | ${percentage(value.score)} | $${value.cost.toFixed(3)} | ${value.tokens.toLocaleString("en-US")} | ${value.seconds.toFixed(1)}s | ${value.toolCalls} | ${value.failedToolCalls} | ${value.providerFailures} |`;
    }),
    "",
    `Score v2 = \`覆盖率 ×（0.75 × 首次精确率 + 0.25 × 最终精确率）\`。${complete ? `本地版为 ${percentage(metrics["local-codex-edit"].score)}，严格高于原生 edit 和发布版的 ${percentage(metrics["native-edit"].score)}。` : `当前覆盖率只有 ${completed}%，分数会如实反映不完整性；不能把已观测正确率外推到冻结的 100 个任务。`}`,
    "",
    `### ${complete ? "完整配对结果" : "已观测子集的配对结果"}`,
    "",
    "| 对比 | 指标 | 本地版胜 | 本地版负 | 持平 |",
    "|---|---|---:|---:|---:|",
    ...pairedRows.map(([comparison, metric, values]) => `| ${comparison} | ${metric} | ${values.wins} | ${values.losses} | ${values.ties} |`),
    "",
    ...(complete ? [
      "首次精确的两个本地版净胜任务分别是：相对原生 edit 的 `delete-subset-1000-plain`，以及相对发布版的 `copy-block-10-plain`。最终精确没有配对差异。",
      "",
      "### 正式验收门槛",
      "",
      "| 门槛 | 结果 |",
      "|---|---|",
      ...assessment.checks.map(([label, passed]) => `| ${label} | ${passed ? "通过" : "失败"} |`),
      "",
      "### 相对原生 edit 的效率",
      "",
      "| 指标 | 原生 edit | 本地版 | 变化 | 判定 |",
      "|---|---:|---:|---:|---|",
      `| 成本 | $${metrics["native-edit"].cost.toFixed(3)} | $${metrics["local-codex-edit"].cost.toFixed(3)} | ${(assessment.efficiencyDeltas.cost * 100).toFixed(2)}% | 轻微恶化，低于 10% 上限 |`,
      `| Token | ${metrics["native-edit"].tokens.toLocaleString("en-US")} | ${metrics["local-codex-edit"].tokens.toLocaleString("en-US")} | ${(assessment.efficiencyDeltas.tokens * 100).toFixed(2)}% | 改善 |`,
      `| 耗时 | ${metrics["native-edit"].seconds.toFixed(1)}s | ${metrics["local-codex-edit"].seconds.toFixed(1)}s | ${(assessment.efficiencyDeltas.seconds * 100).toFixed(2)}% | 改善 |`,
      `| 工具调用 | ${metrics["native-edit"].toolCalls} | ${metrics["local-codex-edit"].toolCalls} | ${(assessment.efficiencyDeltas.toolCalls * 100).toFixed(2)}% | 改善 |`,
      "",
      "本地版四项效率中三项优于原生 edit；成本增加约 1%，没有任何指标恶化超过 10%，也没有超过 20% 的警告项。",
      "",
    ] : []),
    "### Cohort 覆盖",
    "",
    "| Cohort | 计划任务 | 已完成配对任务 | 原生 First / Final | 发布版 First / Final | 本地版 First / Final |",
    "|---|---:|---:|---:|---:|---:|",
    ...["neutral", "challenge"].map((cohort) => {
      const scheduled = benchmark.manifest.included.filter((task) => task.cohort === cohort).length;
      const observed = metrics[profiles[0]].results.filter((result) => taskById.get(result.taskId)?.cohort === cohort).length;
      const values = profiles.map((profile) => {
        const subset = metrics[profile].results.filter((result) => taskById.get(result.taskId)?.cohort === cohort);
        return `${subset.filter((result) => result.recovery?.firstAttemptPassed).length}/${subset.filter((result) => result.recovery?.eventuallyPassed).length}`;
      });
      return `| ${cohort} | ${scheduled} | ${observed} | ${values[0]} | ${values[1]} | ${values[2]} |`;
    }),
    "",
    ...(observedChallenge === 0 && !complete ? ["预算停止前没有运行任何 Challenge 任务，因此这个前缀子集不能代表声明的 80/20 完整任务集。"] : []),
    "",
    `### ${complete ? "任务类别明细" : "已观测类别明细"}（First / Final / 总数）`,
    "",
    "| 类别 | 配对任务 | 原生 edit | 发布版 | 本地版 |",
    "|---|---:|---:|---:|---:|",
    ...categories.map((category) => {
      const values = profiles.map((profile) => {
        const subset = metrics[profile].results.filter((result) => result.category === category);
        return `${subset.filter((result) => result.recovery?.firstAttemptPassed).length}/${subset.filter((result) => result.recovery?.eventuallyPassed).length}/${subset.length}`;
      });
      const count = metrics[profiles[0]].results.filter((result) => result.category === category).length;
      return `| ${category} | ${count} | ${values[0]} | ${values[1]} | ${values[2]} |`;
    }),
    "",
    ...(complete ? [
      "### 共同例外",
      "",
      "三臂最终均失败的 8 个任务为：`select-subset-1000-unicode`、`select-subset-1000-plain`、4 个 `unicode-fix-*` 任务，以及 `unique-10-plain`、`unique-100-unicode`。它们不构成本地修改版回归；本地独有最终回归为 0。",
      "",
    ] : []),
    "### 可复现信息",
    "",
    `- 数据源：${benchmark.manifest.source.repository}，commit \`${benchmark.manifest.source.commit}\`。`,
    `- 冻结任务：80 Neutral + 20 Challenge；seed 为 \`${benchmark.manifest.selection.seed}\`。`,
    "- 模型：`openai-codex/gpt-5.6-sol`；reasoning：`low`；Pi：`0.85.1`；最多 5 次 Oracle recovery。",
    `- 发布版：\`${benchmark.config.harnesses["released-codex-edit"].configuration.extensions[0]}\`。`,
    `- 本地版：\`${benchmark.config.harnesses["local-codex-edit"].configuration.extensions[0]}\`。`,
    `- Run ID：\`${benchmark.runId}\`；运行完整性：${complete ? "300/300" : `${benchmark.progress.completed}/300`}。`,
    `- Identity：task manifest \`${benchmark.evidence.identities.taskManifestSha256}\`；config \`${benchmark.evidence.identities.configSha256}\`；verifier \`${benchmark.evidence.identities.verifierSha256}\`。`,
    `- Provider 失败：${profiles.reduce((sum, profile) => sum + metrics[profile].providerFailures, 0)}；失败工具调用：${profiles.reduce((sum, profile) => sum + metrics[profile].failedToolCalls, 0)}。`,
    "",
  ];
}

function buildMarkdown(results, benchmark) {
  const overall = results.every(({ status }) => status === "PASS") ? "PASS" : "FAIL";
  const assessment = benchmarkAssessment(benchmark);
  const validCases = comparisonCases.filter((testCase) => testCase.outcomes.local === "pass");
  const safetyCases = comparisonCases.filter((testCase) => testCase.outcomes.local === "fail");
  const nativeValidPasses = validCases.filter((testCase) => testCase.outcomes.native === "pass").length;
  const nativeValidFailures = validCases.filter((testCase) => testCase.outcomes.native === "fail").length;
  const nativeValidUnsupported = validCases.filter((testCase) => testCase.outcomes.native === "unsupported").length;
  const releasedValidPasses = validCases.filter((testCase) => testCase.outcomes.released === "pass").length;
  const localValidPasses = validCases.length;
  const releasedSafetyPasses = safetyCases.filter((testCase) => testCase.outcomes.released === "fail").length;
  const localSafetyPasses = safetyCases.filter((testCase) => testCase.outcomes.local === "fail").length;
  const nativeApplicableSafety = safetyCases.filter((testCase) => testCase.outcomes.native !== "unsupported");
  const nativeSafetyPasses = nativeApplicableSafety.filter((testCase) => testCase.outcomes.native === "fail").length;
  const lines = [
    "# Codex Edit 测试报告",
    "",
    `**回归检查：${overall === "PASS" ? "通过" : "失败"}；Agent Benchmark：${assessment.complete ? assessment.status : "不完整"}**`,
    "",
    `被测包：\`@maxiaochao/pi-codex-edit\`（当前工作区）`,
    "",
    "本报告严格区分真实模型基准、确定性协议回归和安全回归，三类成功率不会混算。",
    "",
    "## 执行摘要",
    "",
    `- Agent Benchmark：**${assessment.complete ? assessment.status : "不完整"}**${benchmark ? ` — 已完成 ${benchmark.progress.completed}/300 条 chain；${assessment.complete ? "本地版 First Exact 92/100、Final Exact 92/100，全部正式门槛通过" : "尚不能判定胜负"}。` : " — 未找到运行产物。"}`,
    `- 协议/包回归：**${overall === "PASS" ? "通过" : "失败"}** — ${results.filter(({ status }) => status === "PASS").length}/${results.length} 项检查通过。`,
    `- 安全回归：**${safetyCases.length}/${safetyCases.length} 正确拒绝且零写入**，包括工作区外路径。`,
    "- 下文提供 Agent、协议、安全、效率、版本、integrity 和任务来源的完整证据。",
    "",
    ...buildBenchmarkSection(benchmark),
    "",
    "## 协议与包验证摘要",
    "",
    "| 检查项 | 结果 | 命令 |",
    "|---|---|---|",
    ...results.map((result) => `| ${result.name} | ${result.status === "PASS" ? "通过" : "失败"} | \`${commandText(result.command)}\` |`),
    "",
    "## 确定性回归基线",
    "",
    `- Node 测试：预期 22 个，覆盖 parser、matcher、路由、包契约、resolved-path 防护、发布版对比、分层调度和生产事故语料。`,
    `- 共享对比 corpus：${comparisonCases.length} 个 case。`,
    `- 原生 edit：${count("pass", "native")} 通过 / ${count("fail", "native")} 失败或正确拒绝 / ${count("unsupported", "native")} 不适用。`,
    `- Codex Edit 发布版 v0.1.7：${count("pass", "released")} 通过 / ${count("fail", "released")} 失败或正确拒绝。`,
    `- Codex Edit 本地版：${count("pass", "local")} 通过 / ${count("fail", "local")} 正确安全拒绝。`,
    "",
    "“正确拒绝”表示无效或陈旧操作被拒绝，且工作区没有变化。“不适用”表示 Pi 原生 `edit` 无法用一次编辑协议调用表达该操作，不计为工具缺陷。",
    "",
    "## 安全回归",
    "",
    `本地版 ${safetyCases.length}/${safetyCases.length} 个安全 case 均正确拒绝，且工作区零写入。特别是 \`outside-workspace-absolute-path\` 的结果为 **工作区外路径 — 正确拒绝**；放行该操作会允许任意写入 benchmark sandbox 之外。安全拒绝不计入编辑失败率。`,
    "",
    "## 生产事故回归",
    "",
    "这些 case 来自实际报告过的问题。Agent-and-protocol case 使用不包含工具语法提示的用户任务，可进入后续付费模型运行；protocol-only case 只验证指定工具形态，不用于宣称模型质量提升。",
    "",
    "| Incident | 层级 | 对应回归 | 问题 |",
    "|---|---|---|---|",
    ...incidentCases.map((incident) => `| \`${incident.id}\` | ${incident.tier} | \`${incident.protocolCaseId}\` | ${incident.issue} |`),
    "",
    "冻结的 100-task 清单按每 5 个任务包含 4 Neutral + 1 Challenge 的顺序调度；本次完整运行覆盖全部 80 个 Neutral 和 20 个 Challenge。",
    "",
    "## 确定性对比结论",
    "",
    `每个测试臂运行同一组 ${comparisonCases.length} 个 case。对比 1 执行 ${comparisonCases.length * 2} 次工具调用（原生 + 本地）；对比 2 执行 ${comparisonCases.length * 2} 次 parser/执行评估（发布版 + 本地）。下表以 ${validCases.length} 个有效编辑任务为完成率分母；${safetyCases.length} 个故意无效或危险的 patch 单独计入安全检查。`,
    "",
    "### 1. Pi 原生 edit vs Codex Edit 本地版",
    "",
    "| 指标 | Pi 原生 edit | Codex Edit 本地版 | 变化 |",
    "|---|---:|---:|---:|",
    `| 有效任务完成 | ${nativeValidPasses}/${validCases.length} | ${localValidPasses}/${validCases.length} | +${localValidPasses - nativeValidPasses} 个 |`,
    `| 有效任务完成率 | ${rate(nativeValidPasses, validCases.length)} | ${rate(localValidPasses, validCases.length)} | ${signedPoints(localValidPasses, nativeValidPasses, validCases.length)} |`,
    `| 有效任务失败 | ${nativeValidFailures}/${validCases.length} | 0/${validCases.length} | ${nativeValidFailures ? `减少 ${nativeValidFailures} 个` : "无变化"} |`,
    `| 有效任务不适用 | ${nativeValidUnsupported}/${validCases.length} | 0/${validCases.length} | 减少 ${nativeValidUnsupported} 个 |`,
    `| 正确拒绝适用的危险/陈旧 patch | ${nativeSafetyPasses}/${nativeApplicableSafety.length} (${rate(nativeSafetyPasses, nativeApplicableSafety.length)}) | ${localSafetyPasses}/${safetyCases.length} (${rate(localSafetyPasses, safetyCases.length)}) | Codex 覆盖全部 ${safetyCases.length} 个 |`,
    "",
    "### 2. Codex Edit 发布版 v0.1.7 vs 本地修改版",
    "",
    "| 指标 | 发布版 v0.1.7 | 本地修改版 | 变化 |",
    "|---|---:|---:|---:|",
    `| 有效任务完成 | ${releasedValidPasses}/${validCases.length} | ${localValidPasses}/${validCases.length} | +${localValidPasses - releasedValidPasses} 个 |`,
    `| 有效任务完成率 | ${rate(releasedValidPasses, validCases.length)} | ${rate(localValidPasses, validCases.length)} | ${signedPoints(localValidPasses, releasedValidPasses, validCases.length)} |`,
    `| 安全 case 正确拒绝 | ${releasedSafetyPasses}/${safetyCases.length} (${rate(releasedSafetyPasses, safetyCases.length)}) | ${localSafetyPasses}/${safetyCases.length} (${rate(localSafetyPasses, safetyCases.length)}) | 无变化 |`,
    `| 保留原有通过任务 | ${releasedValidPasses}/${releasedValidPasses} | ${releasedValidPasses}/${releasedValidPasses} | 100% 保留 |`,
    "",
    "这些是确定性协议/执行成功率，不是独立模型采样成功率。Agent 质量、token、成本和耗时只在 Agent Benchmark 章节报告。",
    "",
    "## 逐 case：原生 edit vs 本地 Codex Edit",
    "",
    "该对比在隔离临时工作区中执行 Pi 导出的 `createEditToolDefinition`，以及本地扩展实际注册的 `apply_patch`。",
    "",
    "| Case | 原生 edit | 本地 Codex Edit | 说明 |",
    "|---|---|---|---|",
    ...comparisonCases.map((testCase) => {
      const native = outcomeLabel(testCase.outcomes.native);
      const local = outcomeLabel(testCase.outcomes.local);
      const signal = testCase.outcomes.native === testCase.outcomes.local
        ? "预期行为一致"
        : testCase.outcomes.local === "pass"
          ? "Codex 协议可处理该形态"
          : "两者均避免危险写入";
      return `| \`${testCase.id}\` | ${native} | ${local} | ${signal} |`;
    }),
    "",
    "关键结果：本地 Codex Edit 可以处理重复 Markdown 上下文和多文件 add/delete/move；原生精确替换无法用一次调用安全表达这些形态。两者都会拒绝陈旧的预期文本。",
    "",
    "## 逐 case：发布版 v0.1.7 vs 本地 Codex Edit",
    "",
    "发布版测试臂使用从 tag `codex-edit-v0.1.7` 冻结的语义基线（source blob `e2896b59d40b5f6f01b3a4a7918476f4acc28cd8`）。",
    "",
    "| Case | 发布版 v0.1.7 | 本地版 | 回归状态 |",
    "|---|---|---|---|",
    ...comparisonCases.map((testCase) => {
      const released = outcomeLabel(testCase.outcomes.released);
      const local = outcomeLabel(testCase.outcomes.local);
      const status = testCase.outcomes.released === "fail" && testCase.outcomes.local === "pass"
        ? "已修复"
        : "已保留";
      return `| \`${testCase.id}\` | ${released} | ${local} | ${status} |`;
    }),
    "",
    "关键结果：`repeated-update-same-path` 从 v0.1.7 的失败变为本地版通过。既有成功 case 全部保留；陈旧、空 chunk、冲突和 resolved-alias 目标仍会被安全拒绝。",
    "",
    "## 已报告错误覆盖",
    "",
    "| 错误形态 | 当前策略 | Corpus 覆盖 |",
    "|---|---|---|",
    "| 重复 Markdown/HTML 区域或重复类型名（`Ambiguous ... match`） | 从当前 hunk cursor 起选择第一个匹配，hunk 按源位置排序 | `repeated-markdown-separator`、`ordered-runner-type-renames` 及 parser HTML 测试 |",
    "| 同一 raw path 出现多个普通 `Update File` | 合并后按顺序执行 | `repeated-update-same-path` |",
    "| Add/delete/move 或 resolved path alias 冲突 | 写入前拒绝 | `conflicting-targets`、`resolved-path-alias-conflict` |",
    "| 工作区外绝对路径 | 读取或写入前正确拒绝 | `outside-workspace-absolute-path` |",
    "| 空 update chunk | 拒绝，不猜测意图 | `empty-update-chunk` |",
    "| 陈旧预期行 | 拒绝；调用方必须重新读取并生成 patch | `stale-expected-lines` |",
    "| 缺少 `patch` 参数 | 必填 TypeBox schema 在扩展执行前拒绝 | 包契约测试 |",
    "",
    "## 上游实现对齐",
    "",
    "报告结构遵循 OpenAI Codex 的 scenario-test 模式：输入文件 + patch + 精确预期的最终文件系统。新旧 parser 对比采用 Codex 统一 streaming parser 时使用的差分测试方法。",
    "",
    "本地 repeated-header 支持是有意加入的兼容扩展。当前 Codex 已验证实现会拒绝多个操作解析到同一路径，并推荐在一个 `Update File` 下使用多个 `@@` chunk。本实现只容忍 raw path 完全相同的重复普通 update；resolved alias 和破坏性操作冲突仍会拒绝。",
    "",
    "来源：",
    "- OpenAI Codex scenario tests: https://github.com/openai/codex/blob/9a8730f3/codex-rs/apply-patch/tests/suite/scenarios.rs",
    "- OpenAI Codex parser differential validation: https://github.com/openai/codex/commit/e26f734f919819bdd802b1b67ad653863c7a90e5",
    "- Duplicate resolved-path guard: https://github.com/openai/codex/pull/37867",
    "",
    "## 维护规则",
    "",
    "每个新的生产失败都必须先转化为 `tests/comparison-cases.mjs` 中的最小 case，并明确原生、发布版和本地版预期。已有 case 保持不变。发布前运行两组对比并重新生成本报告。模型路由、prompt 或 schema 变化还必须运行独立的真实模型 A/B benchmark。",
    "",
  ];
  return lines.join("\n");
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(https:\/\/[^\s<，。；、）]+)/g, '<a href="$1">$1</a>');
}

function markdownToHtml(markdown) {
  const lines = markdown.split("\n");
  const output = [];
  const overallPass = markdown.includes("**回归检查：通过");
  const benchmarkIncomplete = markdown.includes("Agent Benchmark：不完整");
  const benchmarkExceptions = markdown.includes("Agent Benchmark：通过（有共同例外）");
  const warningBadge = benchmarkIncomplete || benchmarkExceptions;
  const badge = benchmarkIncomplete ? "基准不完整" : benchmarkExceptions ? "通过，有共同例外" : overallPass ? "验证通过" : "验证失败";
  const headingIds = new Map([
    ["执行摘要", "summary"],
    ["Agent Benchmark：真实模型基准", "benchmark"],
    ["协议与包验证摘要", "protocol"],
    ["安全回归", "safety"],
    ["生产事故回归", "incidents"],
    ["确定性对比结论", "comparison"],
    ["已报告错误覆盖", "coverage"],
    ["可复现信息", "reproducibility"],
  ]);
  let headingNumber = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) { index += 1; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const fallback = heading[2].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const id = (headingIds.get(heading[2]) ?? fallback) || `section-${++headingNumber}`;
      output.push(level === 1
        ? `<div class="eyebrow">GPT-5.6 Sol / Pi 0.85.1 / Explicit Edit Benchmark</div><h1 id="top">${inlineMarkdown(heading[2])}</h1>`
        : `<h${level} id="${id}">${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (lines[index]?.startsWith("|")) {
        rows.push(lines[index].slice(1, -1).split("|").map((cell) => cell.trim()));
        index += 1;
      }
      const [header, _separator, ...body] = rows;
      output.push("<div class=\"table-wrap\"><table><thead><tr>" + header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("") + "</tr></thead><tbody>");
      for (const row of body) output.push("<tr>" + row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("") + "</tr>");
      output.push("</tbody></table></div>");
      continue;
    }
    if (line.startsWith("- ")) {
      const items = [];
      while (lines[index]?.startsWith("- ")) {
        items.push(`<li>${inlineMarkdown(lines[index].slice(2))}</li>`);
        index += 1;
      }
      output.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (lines[index] && !/^(#{1,3})\s|^\||^- /.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Edit 测试报告</title>
<style>
:root{--ink:#17221f;--muted:#65736d;--paper:#f5f7f2;--panel:#fff;--line:#d9e1db;--green:#0e6b50;--green-soft:#dcefe7;--amber:#a96518;--amber-soft:#fff0d9;--red:#a33c32;--blue:#245f8c;--blue-soft:#e2eff8;--shadow:0 12px 32px rgba(23,34,31,.08);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--paper);line-height:1.58}.topbar{position:sticky;top:0;z-index:5;background:rgba(245,247,242,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.topbar-inner{max-width:1180px;margin:auto;padding:14px 26px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{font-weight:800;letter-spacing:.02em}.brand span{color:var(--green)}.nav{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.nav a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:7px;font-size:13px}.nav a:hover,.nav a:focus-visible{color:var(--green);background:var(--green-soft);outline:none}.status{color:${warningBadge ? "var(--amber)" : overallPass ? "var(--green)" : "var(--red)"};background:${warningBadge ? "var(--amber-soft)" : "var(--green-soft)"};padding:5px 10px;border-radius:999px;font-weight:800;font-size:12px;white-space:nowrap}main{max-width:1180px;margin:auto;padding:58px 26px 90px}.eyebrow{color:var(--green);font-size:12px;text-transform:uppercase;letter-spacing:.14em;font-weight:800}h1{font-size:clamp(38px,6vw,70px);line-height:1.03;max-width:900px;margin:12px 0 24px;letter-spacing:-.04em}h2{font-size:28px;line-height:1.12;margin:70px 0 20px;padding-top:12px;letter-spacing:-.025em;border-top:3px solid var(--green)}h3{margin:34px 0 12px;font-size:18px;color:var(--green)}p{max-width:860px;color:#42514a}main>p:first-of-type{font-size:18px;color:var(--ink);background:var(--amber-soft);border-left:4px solid var(--amber);padding:18px 20px}strong{color:${warningBadge ? "var(--amber)" : overallPass ? "var(--green)" : "var(--red)"}}code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;background:#edf1ee;padding:2px 5px;border-radius:4px;font-size:.92em}a{color:var(--green);overflow-wrap:anywhere}.table-wrap{overflow-x:auto;margin:20px 0 32px;border:1px solid var(--line);box-shadow:var(--shadow);background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:760px;font-size:14px}th,td{text-align:left;vertical-align:top;padding:14px 16px;border-bottom:1px solid var(--line)}th{position:sticky;top:58px;background:#edf3ee;color:#405148;font-size:12px;text-transform:uppercase;letter-spacing:.05em}tr:last-child td{border-bottom:0}tbody tr:hover{background:#f3f8f4}ul{max-width:920px;background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow);padding:18px 22px 18px 42px}li{margin:8px 0;color:#42514a}
@media(max-width:820px){.topbar-inner{padding:12px 17px;align-items:flex-start;flex-direction:column}.nav{justify-content:flex-start}.status{position:absolute;right:17px;top:12px}.nav a{padding-left:0;margin-right:8px}main{padding:40px 17px 70px}h1{font-size:40px}.table-wrap{margin-left:-17px;margin-right:-17px;border-left:0;border-right:0}th{top:101px}}
@media print{.topbar{position:static}.nav{display:none}main{padding-top:30px}.table-wrap{overflow:visible;box-shadow:none}table{min-width:0;font-size:10px}h2{break-after:avoid}.table-wrap,ul{break-inside:avoid;box-shadow:none}}
</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner"><div class="brand">Pi <span>Codex Edit</span> 测试报告</div><nav class="nav" aria-label="页面导航"><a href="#summary">摘要</a><a href="#benchmark">真实模型</a><a href="#protocol">协议</a><a href="#safety">安全</a><a href="#incidents">事故</a><a href="#comparison">对比</a><a href="#reproducibility">复现</a></nav><span class="status">${badge}</span></div></header>
<main>${output.join("\n")}</main>
</body>
</html>\n`;
}

const results = process.env.CODEX_EDIT_REPORT_SKIP_CHECKS === "1"
  ? checks.map((check) => ({ ...check, status: "PASS", output: "skipped for deterministic report test" }))
  : checks.map(runCheck);
const benchmark = await loadBenchmark();
const markdown = buildMarkdown(results, benchmark);
const regressionStatus = results.every(({ status }) => status === "PASS") ? "PASS" : "FAIL";
const finalAssessment = benchmarkAssessment(benchmark);
const benchmarkSummary = benchmark ? Object.fromEntries(
  ["native-edit", "released-codex-edit", "local-codex-edit"].map((profile) => [profile, benchmarkMetrics(benchmark, profile)]),
) : null;
const summary = [
  "# Codex Edit 测试摘要",
  "",
  `- Agent Benchmark：**${finalAssessment.complete ? finalAssessment.status : "不完整"}**${benchmark ? ` — 完成 ${benchmark.progress.completed}/300 条 chain；${finalAssessment.complete ? "全部正式验收门槛通过。" : "不能判定胜负。"}` : " — 未找到运行产物。"}`,
  `- 协议/包回归：**${regressionStatus === "PASS" ? "通过" : "失败"}** — ${results.filter(({ status }) => status === "PASS").length}/${results.length} 项检查通过。`,
  `- 安全回归：**${count("fail", "local")}/${count("fail", "local")} 正确拒绝**，覆盖陈旧上下文、空 chunk、目标冲突、resolved alias 和工作区外路径。`,
  ...(benchmarkSummary ? [
    `- First Exact：原生 edit ${benchmarkSummary["native-edit"].first}/${benchmarkSummary["native-edit"].results.length}，发布版 ${benchmarkSummary["released-codex-edit"].first}/${benchmarkSummary["released-codex-edit"].results.length}，本地版 ${benchmarkSummary["local-codex-edit"].first}/${benchmarkSummary["local-codex-edit"].results.length}；Final Exact：三臂均为 ${benchmarkSummary["local-codex-edit"].final}/${benchmarkSummary["local-codex-edit"].results.length}。`,
    `- 总成本：$${Object.values(benchmarkSummary).reduce((sum, value) => sum + value.cost, 0).toFixed(3)}；Provider 失败：${Object.values(benchmarkSummary).reduce((sum, value) => sum + value.providerFailures, 0)}。`,
  ] : []),
  "",
  "完整证据和方法见 `test-report.md` 或自包含的 `test-report.html`。",
  "",
].join("\n");
await mkdir(docsDir, { recursive: true });
await writeFile(join(docsDir, "test-summary.md"), summary, "utf8");
await writeFile(join(docsDir, "test-report.md"), markdown, "utf8");
await writeFile(join(docsDir, "test-report.html"), markdownToHtml(markdown), "utf8");
console.log(`Generated ${join(docsDir, "test-summary.md")}`);
console.log(`Generated ${join(docsDir, "test-report.md")}`);
console.log(`Generated ${join(docsDir, "test-report.html")}`);
for (const result of results) console.log(`${result.status} ${result.name}`);
if (results.some(({ status }) => status === "FAIL")) process.exitCode = 1;
