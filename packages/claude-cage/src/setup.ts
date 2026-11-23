import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CageProfile } from "./profile.ts";
import { runCageSetupStep } from "./transport.ts";

const guest = new URL("../guest/", import.meta.url);
const GUEST_FILES = [
	"client.mjs", "service.mjs", "protocol.mjs", "package.json", "package-lock.json",
	"pi-claude-cage.service", "pi-claude-cage.socket",
];
const PREFLIGHT = `set -eu
if systemctl --user show-environment >/dev/null; then printf 'PI_CAGE_CHECK=systemd\n'; fi
if node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
  printf 'PI_CAGE_CHECK=node\n'
  node_path=$(node -p 'process.execPath')
  export PATH="\${node_path%/*}:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
fi
if claude --version >/dev/null; then printf 'PI_CAGE_CHECK=claude\n'; fi
printf 'PI_CAGE_CLIENT=%s/.local/share/pi-claude-cage/client.mjs\n' "$HOME"
`;

export async function checkGuest(profile: CageProfile, signal: AbortSignal) {
	const output = await runCageSetupStep(profile, PREFLIGHT, undefined, signal, 20_000);
	const lines = output.split("\n");
	const missing = [
		["systemd", "a working systemd user manager"],
		["node", "Node.js 22.19 or later"],
		["claude", "a working claude --version"],
	].filter(([key]) => !lines.includes(`PI_CAGE_CHECK=${key}`)).map(([, label]) => label);
	if (missing.length) throw new Error(`The configured Cage guest needs ${missing.join(", ")}`);
	if (!lines.includes(`PI_CAGE_CLIENT=${profile.clientPath}`)) {
		throw new Error("The guest installer uses $HOME/.local/share/pi-claude-cage/client.mjs. Correct clientPath or install manually.");
	}
}

export async function installGuest(profile: CageProfile, signal: AbortSignal) {
	const script = await readFile(new URL("install.sh", guest), { encoding: "utf8", signal });
	const { stdout: archive } = await promisify(execFile)(
		"tar", ["-C", fileURLToPath(guest), "-czf", "-", "--", ...GUEST_FILES],
		{ encoding: "buffer", maxBuffer: 2 * 1024 * 1024, timeout: 10_000, signal },
	);
	const output = await runCageSetupStep(profile, script, archive, signal, 240_000);
	if (!output.split("\n").includes(`Installed guest client: ${profile.clientPath}`)) {
		throw new Error("The installer did not confirm the configured clientPath. Check the guest installation before retrying setup.");
	}
}
