import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const env = { ...process.env };
delete env.PI_HERDR_SUBAGENTS_CHILD;
const result = spawnSync(process.env.PI_TEST_BINARY || "pi", [
	"-ne", "-ns", "--no-session", "-e", "./tests/extension-contract.ts",
], {
	cwd: fileURLToPath(new URL("../", import.meta.url)), env, encoding: "utf8", timeout: 45_000,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assert.ifError(result.error);
assert.equal(result.status, 0, "Pi extension contract process failed");
// Pi may exit zero when an extension's top-level await never settles.
assert.match(`${result.stdout}\n${result.stderr}`, /^PASS Herdr extension registration, schema and foreground UI contracts\r?$/m,
	"Pi exited without completing the extension contract fixture");
