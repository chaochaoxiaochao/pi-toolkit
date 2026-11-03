import { fileURLToPath } from "node:url";

// The test command preloads background-tasks/tests/runtime.mjs, which resolves Pi
// peers from the selected host Pi (managed installs included). Resolve through it.
function piPackageEntry(packageName) {
	return fileURLToPath(import.meta.resolve(`@earendil-works/${packageName}`));
}

export function piAiEntry() {
	return piPackageEntry("pi-ai");
}

export function piCodingAgentEntry() {
	return piPackageEntry("pi-coding-agent");
}
