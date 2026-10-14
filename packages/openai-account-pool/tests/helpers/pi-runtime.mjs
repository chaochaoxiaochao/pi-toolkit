import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Absolute entry of the pi-ai runtime. This repository has no node_modules and the pool only
 * ever runs inside pi, so the integration checks load the same pi-ai the installed pi uses.
 */
export function piAiEntry() {
	try { return createRequire(import.meta.url).resolve("@earendil-works/pi-ai"); } catch { /* No local install; fall back to the pi on PATH. */ }
	let binary = "";
	try { binary = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim(); } catch { /* Reported below. */ }
	if (!binary) throw new Error("pi is not on PATH, so @earendil-works/pi-ai cannot be located for the integration checks.");
	let directory = dirname(realpathSync(binary));
	for (let depth = 0; depth < 12; depth++) {
		const candidate = join(directory, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`Could not locate @earendil-works/pi-ai next to ${binary}.`);
}
