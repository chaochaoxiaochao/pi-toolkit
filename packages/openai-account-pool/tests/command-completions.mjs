import assert from "node:assert/strict";

import { codexPoolArgumentCompletions } from "../src/command-completions.ts";

assert.deepEqual(codexPoolArgumentCompletions("sta"), [{ value: "status", label: "status" }]);
assert.deepEqual(codexPoolArgumentCompletions("status"), [], "an exact subcommand must let Enter submit immediately");
assert.deepEqual(codexPoolArgumentCompletions("use"), [], "every exact subcommand must hide its identical completion");
assert.deepEqual(codexPoolArgumentCompletions("use 2"), [], "account arguments are not subcommand completions");

console.log("Command completion tests passed");
