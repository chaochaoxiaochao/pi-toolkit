// Package-local host-peer resolution so the packed lifecycle test needs no sibling package.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const hostPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => !entry.endsWith("node_modules/.bin")).join(delimiter);
const binary = process.env.PI_TEST_BINARY || execFileSync("sh", ["-c", "command -v pi"], {
	encoding: "utf8", env: { ...process.env, PATH: hostPath },
}).trim();
let root = dirname(realpathSync(binary));
while (!existsSync(join(root, "package.json")) || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
	const parent = dirname(root);
	if (parent === root) throw new Error(`Cannot locate Pi runtime next to ${binary}. Set PI_TEST_BINARY to the installed Pi executable.`);
	root = parent;
}
const hostURL = pathToFileURL(join(root, "dist/index.js")).href;
const peers = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		return peers.has(specifier)
			? nextResolve(specifier, { ...context, parentURL: hostURL })
			: nextResolve(specifier, context);
	},
});
