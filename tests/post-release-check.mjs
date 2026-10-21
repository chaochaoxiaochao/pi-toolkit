import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease } from "../scripts/post-release-check.mjs";

const temp = mkdtempSync(join(tmpdir(), "post-release-test-"));
const cwd = join(temp, "repo");
mkdirSync(cwd);
const exec = (command, args, options = {}) => execFileSync(command, args, { cwd, stdio: "pipe", ...options });
const git = (...args) => exec("git", args).toString().trim();
const write = (path, content) => {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), content);
};
const manifest = (name, version) => JSON.stringify({ name, version, files: ["payload.txt"], repository: { url: "git+https://github.com/example/toolkit.git" } });
let assertions = 0;
try {
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  write("package.json", manifest("@example/toolkit", "1.0.0"));
  write("payload.txt", "root content\n");
  write("packages/child/package.json", manifest("@example/child", "1.0.0"));
  write("packages/child/payload.txt", "child content\n");
  git("add", ".");
  git("commit", "-qm", "base");
  write("package.json", manifest("@example/toolkit", "1.0.1"));
  git("add", ".");
  git("commit", "-qm", "root release");
  git("tag", "v1.0.1");
  const rootSha = git("rev-parse", "HEAD");
  write("package.json", manifest("@example/toolkit", "1.0.2"));
  // Initial child releases are detected by CHANGELOG even without a manifest bump.
  write("packages/child/CHANGELOG.md", "initial release\n");
  git("add", ".");
  git("commit", "-qm", "coordinated release");
  git("tag", "v1.0.2");
  const childSha = git("rev-parse", "HEAD");
  write("package.json", manifest("@example/toolkit", "9.9.9"));
  write("payload.txt", "uncommitted content must not affect checks\n");

  async function scenario({ tag = "v1.0.2", remoteMismatch, workflow = "success", npmError, wrongVersion, wrongHead, corrupt, missingFile, changedIntegrity, pending = false, ...options } = {}) {
    const sha = tag === "v1.0.2" ? childSha : rootSha;
    const calls = [];
    let clock = 0;
    let workflowPolls = 0;
    let npmPolls = 0;
    const packs = new Map();
    const result = await checkRelease({
      tag, cwd, timeout: 2, interval: 1, now: () => clock,
      sleep: async (ms) => { clock += ms; }, log: () => {},
      run(command, args, runOptions) {
        calls.push([command, ...args]);
        if (command === "gh") {
          if (args[1].includes("/git/ref/")) return JSON.stringify({ object: { type: "commit", sha: remoteMismatch ? "bad" : sha } });
          workflowPolls++;
          const status = workflow === "pending" || (pending && workflowPolls === 1) ? "in_progress" : "completed";
          return JSON.stringify({ workflow_runs: [
            { id: 999, head_sha: sha, head_branch: "other-tag", event: "push", status: "completed", conclusion: "failure" },
            ...(pending && workflowPolls === 1 ? [] : [{ id: 1, head_sha: sha, head_branch: tag, event: "push", status, conclusion: workflow, html_url: "https://example.invalid/run/1" }]),
          ] });
        }
        if (command === "npm" && args[0] === "view") {
          npmPolls++;
          if (npmError || (pending && npmPolls === 1)) {
            const error = new Error("npm failed");
            error.stdout = JSON.stringify({ error: { code: npmError ?? "E404" } });
            throw error;
          }
          const child = args[1].includes("/child@");
          return JSON.stringify({ name: child ? "@example/child" : "@example/toolkit", version: wrongVersion ? "0.0.0" : child ? "1.0.0" : tag.slice(1), gitHead: wrongHead ? "bad" : sha, dist: { integrity: "fixture-integrity" } });
        }
        if (command === "npm" && args[0] === "pack") {
          const destination = args.at(-1);
          if (!args[1].startsWith("@")) {
            const pack = JSON.parse(exec(command, args, runOptions).toString())[0];
            packs.set(pack.name, { ...pack, source: join(destination, pack.filename) });
            return JSON.stringify([pack]);
          }
          const name = args[1].slice(0, args[1].lastIndexOf("@"));
          const pack = packs.get(name);
          const output = join(destination, pack.filename);
          copyFileSync(pack.source, output);
          if (corrupt) {
            const bad = join(destination, "bad");
            mkdirSync(join(bad, "package"), { recursive: true });
            exec("tar", ["-xzf", output, "-C", bad]);
            writeFileSync(join(bad, "package/payload.txt"), "tampered content\n");
            exec("tar", ["-czf", output, "-C", bad, "package"]);
          }
          return JSON.stringify([{ ...pack, integrity: changedIntegrity ? "wrong" : "fixture-integrity", files: missingFile ? pack.files.slice(1) : pack.files }]);
        }
        return exec(command, args, runOptions);
      }, ...options,
    });
    return { result, calls, clock };
  }
  const rootOnly = await scenario({ tag: "v1.0.1" });
  assert.equal(rootOnly.calls.filter((call) => call[0] === "npm" && call[1] === "view").length, 1);
  assert.equal(rootOnly.calls.some((call) => call.some((arg) => arg.includes("/git/ref/tags/child-"))), false);
  const coordinated = await scenario({ pending: true });
  assert.equal(coordinated.clock, 2000);
  assert.equal(coordinated.calls.filter((call) => call[0] === "npm" && call[1] === "pack").length, 4);
  assert.ok(coordinated.calls.some((call) => call.includes("repos/example/toolkit/git/ref/tags/child-v1.0.0")));
  assert.equal(readFileSync(join(cwd, "payload.txt"), "utf8"), "uncommitted content must not affect checks\n");
  assertions += 6;
  for (const [options, message] of [
    [{ tag: "child-v1.0.0" }, /expected a root release tag/],
    [{ remoteMismatch: true }, /remote tag .* does not point/],
    [{ workflow: "failure" }, /publish.yml failure/],
    [{ workflow: "pending" }, /timed out waiting for publish.yml/],
    [{ npmError: "E404" }, /timed out waiting for @example\/child@1.0.0/],
    [{ npmError: "E401" }, /npm failed/],
    [{ wrongVersion: true }, /wrong package/],
    [{ wrongHead: true }, /gitHead mismatch/],
    [{ changedIntegrity: true }, /integrity changed/],
    [{ missingFile: true }, /file list or modes differ/],
    [{ corrupt: true }, /content differs.*payload.txt/],
  ]) {
    await assert.rejects(scenario(options), message);
    assertions++;
  }
  for (const args of [["--timeout", "0"], ["--interval", "NaN"], ["v1.0.0", "extra"]]) {
    assert.throws(() => exec(process.execPath, [join(process.cwd(), "scripts/post-release-check.mjs"), ...args]));
    assertions++;
  }
  assert.match(exec(process.execPath, [join(process.cwd(), "scripts/post-release-check.mjs"), "--help"]).toString(), /Usage:/);
  assertions++;
  // Verification never needs to rewrite the checkout, install packages, or publish.
  assert.equal(existsSync(join(cwd, "node_modules")), false);
  assertions++;
  console.log(`Post-release check tests passed (${assertions} assertions)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
