import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Wired does not forward the host's XDG_RUNTIME_DIR. Point the unmodified
// production client at this run's private socket without using /run/user.
const root = dirname(fileURLToPath(import.meta.url));
process.env.XDG_RUNTIME_DIR = root;
appendFileSync(join(root, "clients"), `${process.pid}\n`, { mode: 0o600 });
await import("./client.mjs");
