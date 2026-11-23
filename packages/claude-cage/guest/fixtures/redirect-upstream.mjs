// Test-only preload. Leave the installed relay and CLI settings untouched.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const port = Number(process.env.PI_CLAUDE_CAGE_FIXTURE_PORT);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
https.request = (options) => {
  assert.equal(options.protocol, "https:");
  assert.equal(options.hostname, "api.anthropic.com");
  assert.equal(options.method, "POST");
  assert.equal(options.path, "/v1/messages");
  return http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", port, agent: false });
};
syncBuiltinESMExports();
