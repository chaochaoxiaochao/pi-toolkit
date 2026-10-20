import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function plan(slug, extraEnv = {}) {
	return execFileSync("bash", ["scripts/release-check.sh", ...(slug ? [slug] : [])], {
		encoding: "utf8",
		// Keep routing fixtures independent of changes since the latest release tag.
		env: { ...process.env, RELEASE_CHECK_DRY_RUN: "1", RELEASE_CHECK_BASE_TAG: "HEAD", ...extraEnv },
	});
}

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

const root = plan(undefined, { RELEASE_CHECK_BASE_TAG: "HEAD" });
assert.match(root, /npm run test:root/);
assert.match(root, /npm run load-test:root/);
assert.doesNotMatch(root, /packages\/herdr-subagents test/);
assert.doesNotMatch(root, /run test:real-herdr/);

console.log("Release check routing tests passed");
