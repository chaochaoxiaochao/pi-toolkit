import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Absolute entry of a host Pi package. Prefer a resolvable local runtime; otherwise integration
 * checks use the installed pi on PATH without adding a separate copy of its dependencies.
 */
function piPackageEntry(packageName) {
	try { return createRequire(import.meta.url).resolve(`@earendil-works/${packageName}`); } catch { /* No local install; fall back to the pi on PATH. */ }
	let binary = "";
	try { binary = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim(); } catch { /* Reported below. */ }
	if (!binary) throw new Error(`pi is not on PATH, so @earendil-works/${packageName} cannot be located for the integration checks.`);
	let directory = dirname(realpathSync(binary));
	for (let depth = 0; depth < 12; depth++) {
		const candidate = join(directory, "node_modules", "@earendil-works", packageName, "dist", "index.js");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`Could not locate @earendil-works/${packageName} next to ${binary}.`);
}

export function piAiEntry() {
	return piPackageEntry("pi-ai");
}

export function piCodingAgentEntry() {
	return piPackageEntry("pi-coding-agent");
}
