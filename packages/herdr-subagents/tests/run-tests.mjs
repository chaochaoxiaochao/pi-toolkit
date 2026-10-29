// One maintained entry point for current contracts. Each file runs in an isolated
// process so a stuck fixture fails visibly without keeping the entire suite alive.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
	"config.mjs",
	"config-resolution.mjs",
	"core-state-machine.mjs",
	"live-agent.mjs",
	"batch-contracts.mjs",
	"history-storage.mjs",
	"ownership-cleanup.mjs",
	"herdr-cli.mjs",
	"load-extension-contract.mjs",
	"fleet.mjs",
	"fleet-click.mjs",
	"cleanup-timing.mjs",
	"report-boundary.mjs",
	"report-lifecycle.mjs",
	"standalone-package.mjs",
	"real-herdr-config.test.mjs",
];
for (const file of files) {
	console.log(`\n=== ${file} ===`);
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./tests/runtime.mjs", `tests/${file}`], {
		cwd, stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL",
	});
	if (result.error || result.status !== 0) {
		console.error(`FAIL ${file}: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal}`}`);
		process.exit(1);
	}
}
console.log(`\nPASS ${files.length} test files (current lifecycle, configuration, Fleet and native Pi integration)`);
