import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureFreshAccountCredential, loadPoolSnapshot } from "../../src/auth.ts";
import { withAuthTransaction } from "../../src/store.ts";
import { fakeAccessToken } from "./fixtures.mjs";

/** One pi process: refresh the pooled credential, and write an unrelated provider entry. */
const [authPath, accountId, markerDir, label] = process.argv.slice(2);
const snapshot = await loadPoolSnapshot(authPath);
const account = snapshot.accounts.find((entry) => entry.id === accountId);

const fresh = await ensureFreshAccountCredential({
	authPath,
	account,
	refresh: async (credential) => {
		// Record that this process really performed the token exchange.
		writeFileSync(join(markerDir, `refresh-${label}`), credential.refresh, "utf8");
		await new Promise((resolve) => setTimeout(resolve, 300));
		return { type: "oauth", access: fakeAccessToken(accountId, `rotated-${label}`), refresh: `rotated-refresh-${label}`, expires: Date.now() + 3_600_000, accountId };
	},
});

await withAuthTransaction(authPath, (entries) => ({
	value: { ...entries, [`unrelated-${label}`]: { type: "api_key", key: `\$KEY_${label}` } },
	result: undefined,
}));

process.stdout.write(JSON.stringify({ label, access: fresh.credential.access, refreshed: fresh.refreshed }));
