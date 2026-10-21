#!/usr/bin/env node
// Read-only verification of one root-tag release, including its optional child.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org/";

export async function checkRelease({ tag, timeout = 600, interval = 10, cwd = root, run, log = console.log, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const deadline = now() + timeout * 1000;
  run ??= (command, args, options = {}) => execFileSync(command, args, {
    cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024,
    timeout: Math.max(1, Math.min(60_000, deadline - now())), ...options,
  });
  const text = (command, args, options) => run(command, args, options).toString().trim();
  const json = (command, args, options) => JSON.parse(text(command, args, options));
  tag ??= `v${JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version}`;
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("expected a root release tag such as v0.13.1");

  async function wait(label, check) {
    for (;;) {
      if (await check()) return;
      if (now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      log(`Waiting for ${label}…`);
      await sleep(Math.min(interval * 1000, deadline - now()));
    }
  }

  // Resolve all expected content from the tag, not the current working tree.
  const sha = text("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  const manifestAt = (path) => json("git", ["show", `${sha}:${path === "." ? "" : `${path}/`}package.json`]);
  const manifest = manifestAt(".");
  if (tag !== `v${manifest.version}`) throw new Error("root tag and package version differ");
  const repository = new URL(manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
  if (repository.hostname !== "github.com" || !/^\/[^/]+\/[^/]+$/.test(repository.pathname)) {
    throw new Error("expected a GitHub repository URL in package.json");
  }
  const repo = repository.pathname.slice(1);
  const changed = text("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  const children = [...new Set(changed.split("\n").map((path) => /^packages\/([^/]+)\/(?:package\.json|CHANGELOG\.md)$/.exec(path)?.[1]).filter(Boolean))];
  if (children.length > 1) throw new Error("release changes more than one child package");
  const targets = children.map((slug) => {
    const path = `packages/${slug}`;
    const manifest = manifestAt(path);
    return { path, tag: `${slug}-v${manifest.version}`, manifest };
  });
  targets.push({ path: ".", tag, manifest });

  for (const target of targets) {
    const remote = json("gh", ["api", `repos/${repo}/git/ref/tags/${target.tag}`]);
    if (remote.object.type !== "commit" || remote.object.sha !== sha) {
      throw new Error(`remote tag ${target.tag} does not point directly to ${sha}`);
    }
  }
  log(`Checking ${tag} (${sha})`);
  await wait("publish.yml", () => {
    const { workflow_runs: runs } = json("gh", ["api", `repos/${repo}/actions/workflows/publish.yml/runs?head_sha=${sha}&event=push&per_page=100`]);
    const run = runs.filter((run) => run.head_sha === sha && run.head_branch === tag && run.event === "push")
      .sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed") return false;
    if (run.conclusion !== "success") throw new Error(`publish.yml ${run.conclusion}: ${run.html_url}`);
    log(`Workflow passed: ${run.html_url}`);
    return true;
  });

  const temp = mkdtempSync(join(tmpdir(), "pi-post-release-"));
  try {
    const snapshot = join(temp, "source");
    mkdirSync(snapshot);
    run("git", ["archive", "--format=tar", `--output=${join(temp, "source.tar")}`, sha]);
    run("tar", ["-xf", join(temp, "source.tar"), "-C", snapshot]);
    for (const [index, target] of targets.entries()) {
      const spec = `${target.manifest.name}@${target.manifest.version}`;
      let metadata;
      await wait(spec, () => {
        try {
          metadata = json("npm", ["view", spec, "--json", "--registry", registry]);
        } catch (error) {
          // Only publication propagation is retryable. Auth/network/JSON failures are not a pass.
          let response;
          try { response = JSON.parse(error.stdout?.toString() ?? ""); } catch { /* Report original failure below. */ }
          if (response?.error?.code === "E404") return false;
          throw error;
        }
        if (metadata.name !== target.manifest.name || metadata.version !== target.manifest.version) {
          throw new Error(`npm returned the wrong package for ${spec}`);
        }
        if (metadata.gitHead && metadata.gitHead !== sha) throw new Error(`npm gitHead mismatch for ${spec}`);
        if (!metadata.dist?.integrity) throw new Error(`npm integrity missing for ${spec}`);
        return true;
      });
      const expectedDir = join(temp, `expected-${index}`);
      const publishedDir = join(temp, `published-${index}`);
      mkdirSync(expectedDir);
      mkdirSync(publishedDir);
      const pack = (source, destination) => json("npm", ["pack", source, "--ignore-scripts", "--json", "--registry", registry, "--pack-destination", destination], { cwd: snapshot })[0];
      const expected = pack(resolve(snapshot, target.path), expectedDir);
      const published = pack(spec, publishedDir);
      if (published.integrity !== metadata.dist.integrity) throw new Error(`npm integrity changed for ${spec}`);
      const files = (pack) => pack.files.map(({ path, mode }) => ({ path, mode })).sort((a, b) => a.path.localeCompare(b.path));
      if (JSON.stringify(files(expected)) !== JSON.stringify(files(published))) throw new Error(`tarball file list or modes differ for ${spec}`);
      for (const { path } of expected.files) {
        const member = `package/${path}`;
        const before = run("tar", ["-xOf", join(expectedDir, expected.filename), member]);
        const after = run("tar", ["-xOf", join(publishedDir, published.filename), member]);
        if (!Buffer.from(before).equals(Buffer.from(after))) throw new Error(`tarball content differs for ${spec}: ${path}`);
      }
      log(`Verified ${spec}: ${expected.files.length} files match ${target.tag}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  log(`Release ${tag} verified.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ options: { timeout: { type: "string", default: "600" }, interval: { type: "string", default: "10" }, help: { type: "boolean", short: "h" } }, allowPositionals: true });
    if (values.help) {
      console.log("Usage: node scripts/post-release-check.mjs [vX.Y.Z] [--timeout 600] [--interval 10]\nRequires local release tags, authenticated gh, npm, git and tar. Checks public npm; never installs or publishes.\nDefault tag: current package.json version. Timeout is shared across workflow and npm waits.");
    } else {
      if (positionals.length > 1) throw new Error("expected at most one root tag");
      for (const key of ["timeout", "interval"]) {
        if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) <= 0) throw new Error(`--${key} must be a positive integer`);
      }
      await checkRelease({ tag: positionals[0], timeout: Number(values.timeout), interval: Number(values.interval) });
    }
  } catch (error) {
    console.error(error.stderr?.toString().trim() || error.message);
    process.exitCode = 1;
  }
}
