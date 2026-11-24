import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const installer = join(here, "install.sh");
const revision = "d5b5e04c314d3452d357174d16d10dda34daa2d2";

function script(path, content) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${content}\n`, { mode: 0o700 });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "claude-cage-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const upstream = join(root, "upstream");
  mkdirSync(join(upstream, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(upstream, "src/stream.ts"), "export {};\n");
  writeFileSync(join(upstream, "src/claude-cli.ts"), "export {};\n");
  writeFileSync(join(upstream, "LICENSE"), "fixture\n");
  const systemctlLog = join(root, "systemctl.log");
  script(join(bin, "node"), `
if [ "\${1-}" = -e ]; then printf '%s\\n' "$0"; exit 0; fi
exit 0`);
  script(join(bin, "npm"), "mkdir -p node_modules");
  script(join(bin, "git"), `
case "$1" in
  init) mkdir -p "$3/.git" ;;
  fetch) : ;;
  -C)
    case "$3" in
      rev-parse) printf '%s\\n' '${revision}' ;;
      archive) exec tar -C '${upstream}' -cf - src LICENSE ;;
    esac ;;
esac`);
  script(join(bin, "systemctl"), `printf '%s\\n' "$*" >> '${systemctlLog}'
if [ "\${SYSTEMCTL_FAIL-}" = 1 ]; then exit 1; fi`);
  const archive = execFileSync("tar", ["-C", here, "-czf", "-", "--", "service.mjs", "protocol.mjs", "package.json", "package-lock.json"]);
  return { root, home, bin, archive, systemctlLog };
}

function install(fixture, extraEnv = {}) {
  const child = spawn("bash", [installer], {
    env: { ...process.env, HOME: fixture.home, PATH: `${fixture.bin}:/usr/bin:/bin`, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(fixture.archive);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolve) => child.once("close", (code) => resolve({
    code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
  })));
}

function legacy(fixture) {
  const destination = join(fixture.home, ".local/share/pi-claude-cage");
  const units = join(fixture.home, ".config/systemd/user");
  const environment = join(fixture.home, ".config/pi-claude-cage/environment");
  mkdirSync(destination, { recursive: true });
  mkdirSync(units, { recursive: true });
  mkdirSync(dirname(environment), { recursive: true });
  writeFileSync(join(destination, ".pi-claude-cage-install"), "pi-claude-cage guest installation v1\n");
  writeFileSync(join(destination, "client.mjs"), "old\n");
  writeFileSync(join(units, "pi-claude-cage.service"), "old\n");
  writeFileSync(join(units, "pi-claude-cage.socket"), "old\n");
  writeFileSync(environment, "old\n");
  return { destination, units, environment };
}

test("installer atomically replaces an exact marker-owned v1 install and removes its runtime files", async (t) => {
  const fixtureData = await fixture(t);
  const paths = legacy(fixtureData);
  const result = await install(fixtureData);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(paths.destination, ".pi-claude-cage-install"), "utf8"), "pi-claude-cage guest installation v2\n");
  assert(existsSync(join(paths.destination, "service.mjs")));
  assert(!existsSync(join(paths.destination, "client.mjs")));
  assert(!existsSync(join(paths.units, "pi-claude-cage.service")));
  assert(!existsSync(join(paths.units, "pi-claude-cage.socket")));
  assert(!existsSync(paths.environment));
  assert.deepEqual(readFileSync(fixtureData.systemctlLog, "utf8").trim().split("\n"), [
    "--user disable --now pi-claude-cage.socket",
    "--user stop pi-claude-cage.service",
    "--user daemon-reload",
  ]);
});

test("installer fails closed for unmarked or symlinked destinations", async (t) => {
  for (const kind of ["unmarked", "symlink"]) {
    const fixtureData = await fixture(t);
    const destination = join(fixtureData.home, ".local/share/pi-claude-cage");
    mkdirSync(dirname(destination), { recursive: true });
    if (kind === "unmarked") mkdirSync(destination);
    else symlinkSync(join(fixtureData.home, "elsewhere"), destination);
    const result = await install(fixtureData);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Refusing to replace unknown/);
    assert.doesNotThrow(() => lstatSync(destination));
  }
});

test("failed legacy daemon shutdown preserves the v1 installation", async (t) => {
  const fixtureData = await fixture(t);
  const paths = legacy(fixtureData);
  const result = await install(fixtureData, { SYSTEMCTL_FAIL: "1" });
  assert.notEqual(result.code, 0);
  assert.equal(readFileSync(join(paths.destination, ".pi-claude-cage-install"), "utf8"), "pi-claude-cage guest installation v1\n");
  assert(existsSync(join(paths.destination, "client.mjs")));
  assert(existsSync(join(paths.units, "pi-claude-cage.service")));
  assert(existsSync(paths.environment));
});
