import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The release gate correctly includes uncommitted changes. Test routing in an
// isolated Git fixture rather than assuming the developer's worktree is clean.
const root = mkdtempSync(join(tmpdir(), "release-routing-"));
mkdirSync(join(root, "scripts"));
copyFileSync(new URL("../scripts/release-check.sh", import.meta.url), join(root, "scripts/release-check.sh"));
for (const slug of ["openai-account-pool", "background-tasks", "herdr-subagents", "worktree"]) {
	mkdirSync(join(root, "packages", slug), { recursive: true });
	copyFileSync(new URL(`../packages/${slug}/package.json`, import.meta.url), join(root, "packages", slug, "package.json"));
}
const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");

function plan(slug, extraEnv = {}) {
	return execFileSync("bash", ["scripts/release-check.sh", ...(slug ? [slug] : [])], {
		encoding: "utf8",
		cwd: root,
		// Keep routing fixtures independent of changes since the latest release tag.
		env: { ...process.env, RELEASE_CHECK_DRY_RUN: "1", RELEASE_CHECK_BASE_TAG: "HEAD", ...extraEnv },
	});
}

try {
	const accountPool = plan("openai-account-pool");
	assert.match(accountPool, /node tests\/package-layout\.mjs/);
	assert.match(accountPool, /npm --prefix packages\/openai-account-pool test/);
	assert.match(accountPool, /npm --prefix packages\/openai-account-pool run load-test/);
	assert.match(accountPool, /npm pack \.\/packages\/openai-account-pool --dry-run/);
	assert.doesNotMatch(accountPool, /npm test/);
	assert.doesNotMatch(accountPool, /packages\/herdr-subagents (?:test|run test:real-herdr)/);
	assert.match(accountPool, /real Herdr child Agent smoke skipped \(Herdr is unchanged\)/);

	const backgroundTasks = plan("background-tasks");
	assert.match(backgroundTasks, /npm --prefix packages\/background-tasks test/);
	assert.match(backgroundTasks, /npm --prefix packages\/background-tasks run load-test/);
	assert.match(backgroundTasks, /npm pack \.\/packages\/background-tasks --dry-run/);
	assert.doesNotMatch(backgroundTasks, /packages\/herdr-subagents (?:test|run test:real-herdr)/);

	const herdr = plan("herdr-subagents");
	assert.match(herdr, /npm --prefix packages\/herdr-subagents test/);
	assert.match(herdr, /npm --prefix packages\/herdr-subagents run load-test/);
	assert.match(herdr, /npm --prefix packages\/herdr-subagents run test:real-herdr/);

	const worktree = plan("worktree");
	assert.match(worktree, /npm --prefix packages\/worktree test/);
	assert.doesNotMatch(worktree, /npm --prefix packages\/worktree run load-test/);

	const rootPlan = plan(undefined, { RELEASE_CHECK_BASE_TAG: "HEAD" });
	assert.match(rootPlan, /npm run test:root/);
	assert.match(rootPlan, /npm run load-test:root/);
	assert.doesNotMatch(rootPlan, /packages\/herdr-subagents test/);
	assert.doesNotMatch(rootPlan, /run test:real-herdr/);

	console.log("Release check routing tests passed");
	appendFileSync(join(root, "packages/herdr-subagents/package.json"), "\n");
	assert.match(plan("openai-account-pool"), /run test:real-herdr/, "Uncommitted Herdr changes must still require its smoke check");
} finally {
	rmSync(root, { recursive: true, force: true });
}
