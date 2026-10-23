import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "herdr-standalone-"));
try {
	const source = resolve(import.meta.dirname, "..");
	const [packed] = JSON.parse(execFileSync("npm", [
		"pack", source, "--ignore-scripts", "--json", "--pack-destination", root,
	], { cwd: root, encoding: "utf8" }));
	execFileSync("tar", ["-xzf", join(root, packed.filename), "-C", root]);
	const output = execFileSync(process.execPath, ["--experimental-strip-types", "tests/report-lifecycle.mjs"], {
		cwd: join(root, "package"), encoding: "utf8", timeout: 30000,
	});
	const results = output.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(results.length, 10, "all native lifecycle cases must execute outside the workspace");
	assert.ok(results.every((result) => result.reportExists));
	console.log("PASS standalone Herdr tarball: ten native offline lifecycle cases without sibling packages");
} finally {
	rmSync(root, { recursive: true, force: true });
}
