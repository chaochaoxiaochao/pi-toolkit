#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PI_VERSION = "0.85.1";
const MODEL = "openai-codex/gpt-5.6-sol";
const THINKING = "low";
const PACKAGE = "@maxiaochao/pi-codex-edit";
const nodeBinary = realpathSync(execFileSync("which", ["node"], { encoding: "utf8" }).trim());
const nodeRuntime = dirname(dirname(nodeBinary));
const root = resolve(".cache/codex-edit-benchmark");
const authFile = join(homedir(), ".pi/agent/auth.json");
const modelFile = join(homedir(), ".pi/agent/models.json");
for (const file of [authFile, modelFile]) {
  if (!existsSync(file)) throw new Error(`Required Pi state is missing: ${file}`);
}

const npmJson = (...args) =>
  JSON.parse(execFileSync("npm", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
const latest = npmJson("view", `${PACKAGE}@latest`, "version", "dist.integrity", "--json");
latest.integrity ??= latest["dist.integrity"];
if (typeof latest.version !== "string" || typeof latest.integrity !== "string") {
  throw new Error("npm latest did not resolve to an exact version and integrity");
}

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const tarballDirectory = join(root, "tarballs");
mkdirSync(tarballDirectory);
const [packed] = npmJson(
  "pack",
  resolve("packages/codex-edit"),
  "--pack-destination",
  tarballDirectory,
  "--json",
);
if (!packed?.filename || !packed?.integrity) throw new Error("Local npm pack returned no integrity");
const localTarball = join(tarballDirectory, packed.filename);

function installRuntime(name, extensionSpec) {
  const directory = join(root, "runtimes", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({ private: true })}\n`);
  const dependencies = [`@earendil-works/pi-coding-agent@${PI_VERSION}`];
  if (extensionSpec) dependencies.push(extensionSpec);
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--save-exact", ...dependencies],
    { cwd: directory, stdio: "inherit" },
  );
  const piManifest = JSON.parse(
    readFileSync(join(directory, "node_modules/@earendil-works/pi-coding-agent/package.json")),
  );
  if (piManifest.version !== PI_VERSION) throw new Error(`${name}: Pi version drifted`);
  if (extensionSpec) {
    const extensionManifest = JSON.parse(
      readFileSync(join(directory, "node_modules/@maxiaochao/pi-codex-edit/package.json")),
    );
    if (!extensionManifest.pi?.extensions?.includes("./extensions/codex-edit.ts")) {
      throw new Error(`${name}: installed package does not declare Codex Edit`);
    }
  }
  return directory;
}

const nativeRuntime = installRuntime("native-edit");
const releasedRuntime = installRuntime("released-codex-edit", `${PACKAGE}@${latest.version}`);
const localRuntime = installRuntime("local-codex-edit", localTarball);
const lock = JSON.parse(readFileSync(join(releasedRuntime, "package-lock.json")));
const releasedLock = lock.packages?.["node_modules/@maxiaochao/pi-codex-edit"];
if (releasedLock?.version !== latest.version || releasedLock?.integrity !== latest.integrity) {
  throw new Error("Released Codex Edit lockfile does not match the npm version and integrity pin");
}

const sourceDigest = createHash("sha256")
  .update(readFileSync(resolve("packages/codex-edit/src/parser.ts")))
  .update(readFileSync(resolve("packages/codex-edit/extensions/codex-edit.ts")))
  .digest("hex");
const commonArgs = [
  "--model",
  MODEL,
  "--thinking",
  THINKING,
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--tools",
  "read,bash,edit,write",
  "--session-dir",
  "/state/pi/sessions",
  "--mode",
  "json",
  "-p",
];
function adapter(name, runtime, extension) {
  const extensionEntry = extension
    ? join(runtime, "node_modules/@maxiaochao/pi-codex-edit/extensions/codex-edit.ts")
    : null;
  const extensionIdentity =
    name === "released-codex-edit"
      ? `${PACKAGE}@${latest.version} (${latest.integrity})`
      : name === "local-codex-edit"
        ? `${PACKAGE}@${packed.version}+local (${packed.integrity})`
        : null;
  return {
    kind: "pi-default",
    command: join(runtime, "node_modules/.bin/pi"),
    args: [
      ...commonArgs,
      ...(extensionEntry ? ["--extension", extensionEntry] : []),
      "--",
      "{prompt}",
    ],
    version: PI_VERSION,
    model: MODEL,
    thinking: THINKING,
    transport: "harness-native",
    ready: false,
    readOnly: [nodeRuntime, join(runtime, "node_modules")],
    seedFiles: { "pi/auth.json": authFile, "pi/models.json": modelFile },
    env: {
      PATH: `${dirname(nodeBinary)}:/usr/local/bin:/usr/bin:/bin`,
      PI_CODING_AGENT_DIR: "/state/pi",
      PI_TELEMETRY: "0",
    },
    agentFamily: "pi",
    agentVersion: PI_VERSION,
    modelFamily: "gpt-5.6-sol",
    modelVersion: "gpt-5.6-sol",
    provider: "openai-codex",
    harnessFamily: name,
    harnessVersion:
      name === "native-edit"
        ? PI_VERSION
        : name === "released-codex-edit"
          ? latest.version
          : `${packed.version}+local.${sourceDigest.slice(0, 12)}`,
    adapterVersion: "1",
    configurationLabels: [`harness/${name}`, extension ? "editor/apply-patch" : "editor/edit"],
    configurationId: `${name}/explicit-edit-v1`,
    configuration: {
      tools: extension ? ["read", "bash", "write", "apply_patch"] : ["read", "bash", "write", "edit"],
      extensions: extensionIdentity ? [extensionIdentity] : [],
      rules: extension ? ["Codex patch grammar", "native write retained"] : [],
      runtimeFlags: [`thinking=${THINKING}`, "clean-pi-resources", "tool-parity-v1"],
      environment: [],
    },
  };
}

const config = {
  harnesses: {
    "native-edit": adapter("native-edit", nativeRuntime, false),
    "released-codex-edit": adapter("released-codex-edit", releasedRuntime, true),
    "local-codex-edit": adapter("local-codex-edit", localRuntime, true),
  },
};
const configPath = join(root, "config.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
const metadata = {
  preparedAt: new Date().toISOString(),
  piVersion: PI_VERSION,
  model: MODEL,
  thinking: THINKING,
  released: { package: PACKAGE, version: latest.version, integrity: latest.integrity },
  local: {
    version: packed.version,
    integrity: packed.integrity,
    shasum: packed.shasum,
    sourceDigest,
  },
  config: configPath,
};
writeFileSync(join(root, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata, null, 2));
