// Resolve host peers from the selected installed Pi; never install a second runtime.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// npm prepends workspace .bin paths, which may contain an older development Pi.
const hostPath = (process.env.PATH ?? "").split(delimiter).filter((entry) => !entry.endsWith("node_modules/.bin")).join(delimiter);
// The managed installer's launcher is a shell script outside the Pi package. Like
// that launcher, read install/current-version on each run so Pi updates need no change.
function managedPiModules(launcher) {
	const install = join(dirname(launcher), "..", "install");
	try {
		const version = readFileSync(join(install, "current-version"), "utf8").trim();
		const modules = join(install, "releases", version, "node_modules");
		return existsSync(join(modules, "@earendil-works", "pi-coding-agent", "package.json")) ? modules : undefined;
	} catch { return undefined; }
}
const binary = process.env.PI_TEST_BINARY || execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8", env: { ...process.env, PATH: hostPath } }).trim();
let root = dirname(realpathSync(binary));
while (!existsSync(join(root, "package.json")) || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
	const parent = dirname(root);
	const managed = parent === root ? managedPiModules(realpathSync(binary)) : undefined;
	if (managed) { root = join(managed, "@earendil-works", "pi-coding-agent"); break; }
	if (parent === root) throw new Error(`Cannot locate Pi runtime next to ${binary}`);
	root = parent;
}
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const [major, minor] = version.split(".").map(Number);
if (major < 1 || (major === 1 && minor < 3)) throw new Error(`Background Tasks checks require Pi >=1.3.0; selected ${version} at ${binary}. Set PI_TEST_BINARY to a supported host.`);
export const piBinary = binary;
export const piEntry = join(root, "dist/index.js");
const hostURL = pathToFileURL(piEntry).href;
const peers = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		return peers.has(specifier)
			? nextResolve(specifier, { ...context, parentURL: hostURL })
			: nextResolve(specifier, context);
	},
});
