import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JWT_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

/** Access token shaped like the Codex one: the account id and sign-in address live in JWT claims. */
export function fakeAccessToken(accountId, marker = "v1", { email, plan } = {}) {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const claims = { [JWT_ACCOUNT_CLAIM]: { chatgpt_account_id: accountId }, marker };
	if (plan) claims[JWT_ACCOUNT_CLAIM].chatgpt_plan_type = plan;
	if (email) claims[JWT_PROFILE_CLAIM] = { email, email_verified: true };
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	return `${header}.${payload}.test-signature`;
}

/** Test-only credential. No real token ever appears in this repository. */
export function fakeCredential(accountId, { marker = "v1", expiresInMs = 3_600_000, now = Date.now(), email, plan } = {}) {
	return {
		type: "oauth",
		access: fakeAccessToken(accountId, marker, { email, plan }),
		refresh: `test-refresh-${accountId}-${marker}`,
		expires: now + expiresInMs,
		accountId,
	};
}

export function makeAgentDir(prefix = "openai-account-pool-") {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	return {
		directory,
		authPath: join(directory, "auth.json"),
		dispose() { rmSync(directory, { recursive: true, force: true }); },
	};
}

export function seedAuthFile(authPath, entries) {
	writeFileSync(authPath, JSON.stringify(entries, null, 2), { encoding: "utf8", mode: 0o600 });
}
