#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: run-with-budget.mjs --progress <progress.json> --stop-cost <usd> --max-cost <usd> -- <command> [args...]");
  process.exit(2);
}

const separator = process.argv.indexOf("--");
if (separator < 0) usage("Missing -- before the runner command");
const options = process.argv.slice(2, separator);
const command = process.argv.slice(separator + 1);
const valueFor = (name) => {
  const index = options.indexOf(name);
  return index < 0 ? undefined : options[index + 1];
};
const progressPath = valueFor("--progress");
const stopCost = Number(valueFor("--stop-cost"));
const maxCost = Number(valueFor("--max-cost"));
if (!progressPath || !command.length || !Number.isFinite(stopCost) || !Number.isFinite(maxCost) || stopCost <= 0 || maxCost < stopCost) usage();

function observedCost(progress) {
  return (progress.results ?? []).reduce((sum, result) => sum + (result.recovery?.attempts ?? []).reduce(
    (attemptSum, attempt) => attemptSum + Number(attempt.execution?.costUsd ?? 0),
    0,
  ), 0);
}

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  detached: process.platform !== "win32",
});
let stopping = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  if (process.platform === "win32") child.kill(signal);
  else process.kill(-child.pid, signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const timer = setInterval(async () => {
  try {
    const progress = JSON.parse(await readFile(progressPath, "utf8"));
    const cost = observedCost(progress);
    if (cost >= stopCost) {
      console.error(`Budget stop: observed $${cost.toFixed(6)} >= scheduling threshold $${stopCost.toFixed(6)}`);
      stop();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(`Budget monitor warning: ${error.message}`);
  }
}, 1_000);
timer.unref();

const exit = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
clearInterval(timer);
let finalCost = 0;
try {
  finalCost = observedCost(JSON.parse(await readFile(progressPath, "utf8")));
} catch {}
if (finalCost > maxCost) {
  console.error(`HARD BUDGET VIOLATION: observed $${finalCost.toFixed(6)} > $${maxCost.toFixed(6)}`);
  process.exit(3);
}
if (stopping) {
  console.error(`Runner stopped by budget gate at $${finalCost.toFixed(6)} (hard cap $${maxCost.toFixed(6)})`);
  process.exit(0);
}
if (exit.signal) {
  console.error(`Runner exited from ${exit.signal}`);
  process.exit(1);
}
process.exit(exit.code ?? 1);
