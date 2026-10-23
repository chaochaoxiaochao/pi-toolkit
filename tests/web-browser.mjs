// Real Chrome regression. All profiles and state belong to a disposable HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = [
  process.env.BROWSER_BIN,
  "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((path) => path && !/\.exe$/i.test(path) && existsSync(path));
assert.ok(binary, "Native Chrome is required; do not use a shared Windows profile for this test");
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
const home = mkdtempSync(join(tmpdir(), "pi-browser-test-"));
const port = await freePort();
const otherPort = await freePort();
const env = { ...process.env, HOME: home, BROWSER_BIN: binary, BROWSER_DEBUG_HOST: "127.0.0.1", BROWSER_DEBUG_PORT: String(port) };
delete env.WSL_DISTRO_NAME;
delete env.WSL_INTEROP;
const startPath = new URL("../skills/web-browser/scripts/start.js", import.meta.url).pathname;
const statePath = join(home, ".cache/agent-web/browser/state.json");
const start = (args = [], extraEnv = {}) => {
  const result = spawnSync(process.execPath, [startPath, "--headless", ...args], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 25000 });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
};
let cdp;
let pid;
try {
  const first = start();
  assert.equal(first.status, 0, first.output);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  pid = state.pid;
  const marker = join(state.userDataDir, "test-must-survive");
  writeFileSync(marker, "not disposable while Chrome is running");
  assert.equal(start().status, 0, "ordinary reuse should still work");
  for (const extraEnv of [{}, { BROWSER_DEBUG_PORT: String(otherPort) }]) {
    const reset = start(["--reset-profile"], extraEnv);
    assert.equal(reset.status, 1, "reset must reject a live profile: " + reset.output);
    assert.equal(readFileSync(marker, "utf8"), "not disposable while Chrome is running");
  }
  rmSync(statePath);
  const withoutState = start(["--reset-profile"], { BROWSER_DEBUG_PORT: String(otherPort) });
  assert.equal(withoutState.status, 1, "a live profile lock must protect missing state");
  assert.ok(existsSync(marker));
  writeFileSync(statePath, JSON.stringify(state));

  process.env.BROWSER_DEBUG_HOST = env.BROWSER_DEBUG_HOST;
  process.env.BROWSER_DEBUG_PORT = env.BROWSER_DEBUG_PORT;
  const { connect } = await import("../skills/web-browser/scripts/cdp.js");
  cdp = await connect();
  const pages = await cdp.getPages();
  const session = await cdp.attachToPage(pages[0].targetId);
  await cdp.navigate(session, "data:text/html,<title>Profile safety check</title><h1>Live profile preserved</h1>");
  assert.equal(await cdp.evaluate(session, "document.title"), "Profile safety check");
  if (process.env.BROWSER_TEST_ARTIFACT_DIR) {
    const directory = resolve(process.env.BROWSER_TEST_ARTIFACT_DIR);
    mkdirSync(directory, { recursive: true });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
    writeFileSync(join(directory, "profile-preserved.png"), Buffer.from(data, "base64"));
  }
  await cdp.send("Browser.close").catch(() => {});
  cdp.close();
  cdp = undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch { pid = undefined; break; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(pid, undefined, "Chrome must stop before reset is tested");
  const resetStopped = start(["--reset-profile"]);
  assert.equal(resetStopped.status, 0, resetStopped.output);
  pid = JSON.parse(readFileSync(statePath, "utf8")).pid;
  assert.equal(existsSync(marker), false, "reset must clear a stopped profile");
  cdp = await connect();
  console.log("PASS Chrome profile reset: live, other port, missing state, CDP navigation, stopped reset");
} finally {
  if (cdp) { await cdp.send("Browser.close").catch(() => {}); cdp.close(); }
  else if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await new Promise((done) => setTimeout(done, 500));
  rmSync(home, { recursive: true, force: true });
}
