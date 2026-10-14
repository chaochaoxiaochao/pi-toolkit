import { rmdirSync } from "node:fs";
import { mkdir, rmdir, stat, utimes } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Directory lock using the on-disk protocol of `proper-lockfile`, the library pi's own auth
 * backend locks `auth.json` with: `<file>.lock` is a directory, its mtime is the holder's
 * heartbeat, and a heartbeat older than the stale window may be reclaimed. Sharing the
 * protocol is what makes pool writes mutually exclusive with pi's own credential writes.
 */

/** Reclaim window for a holder that stopped heart-beating. Matches pi's auth-lock wait window. */
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WAIT_MS = 30_000;
/** Well inside proper-lockfile's 10s default stale window, so pi never reclaims a lock we hold. */
const HEARTBEAT_MS = 2_000;
const MAX_BACKOFF_MS = 500;

/**
 * Stamps the heartbeat with a unique sub-millisecond time, so a directory another holder
 * recreated is recognised even when it reuses our inode and lands in the same millisecond.
 * Filesystems that only keep whole milliseconds degrade to proper-lockfile's own mtime check.
 */
async function stampHeartbeat(directory: string): Promise<bigint> {
	const seconds = (Date.now() + Math.random()) / 1000;
	await utimes(directory, seconds, seconds);
	return (await stat(directory, { bigint: true })).mtimeNs;
}

export class LockTimeoutError extends Error {
	constructor(path: string) {
		super(`Timed out waiting for ${path}. Another pi process is writing credentials.`);
		this.name = "LockTimeoutError";
	}
}

export class LockCompromisedError extends Error {
	constructor(path: string, options?: { cause?: unknown }) {
		super(`Lost the lock on ${path} before the write completed.`, options);
		this.name = "LockCompromisedError";
	}
}

export interface HeldLock {
	/** Throws when the lock was reclaimed or released, so a caller never writes unprotected. */
	assertHeld(): void;
	/** Re-reads the directory, so ownership is checked at write time rather than at the last heartbeat. */
	verifyHeld(): Promise<void>;
	release(): Promise<void>;
}

export interface FileLockOptions {
	staleMs?: number;
	waitMs?: number;
	signal?: AbortSignal;
}

const heldDirectories = new Set<string>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const directory of heldDirectories) {
			try { rmdirSync(directory); } catch { /* Nothing to clean up when the directory is already gone. */ }
		}
	});
}

export function lockDirectoryFor(targetPath: string): string {
	return `${resolve(targetPath)}.lock`;
}

const delay = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolveDelay, reject) => {
	const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Lock wait aborted.")); };
	const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolveDelay(); }, milliseconds);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
});

/** True when the caller should retry `mkdir`, either because the directory is gone or it was stale. */
async function reclaimIfStale(directory: string, staleMs: number): Promise<boolean> {
	let identity;
	try { identity = await stat(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	if (identity.mtimeMs >= Date.now() - staleMs) return false;
	try { await rmdir(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return true;
}

function holdLock(directory: string, stamp: bigint): HeldLock {
	installExitHook();
	heldDirectories.add(directory);
	let ownStamp = stamp;
	let compromised: Error | undefined;
	let released = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const scheduleHeartbeat = () => {
		timer = setTimeout(() => { void heartbeat(); }, HEARTBEAT_MS);
		timer.unref?.();
	};
	/** Any other holder's mkdir or heartbeat replaces our stamp. */
	const assertOwnStamp = async (): Promise<void> => {
		if ((await stat(directory, { bigint: true })).mtimeNs !== ownStamp) throw new LockCompromisedError(directory);
	};
	const heartbeat = async () => {
		if (released) return;
		try {
			await assertOwnStamp();
			ownStamp = await stampHeartbeat(directory);
		} catch (error) {
			compromised = error instanceof LockCompromisedError ? error : new LockCompromisedError(directory, { cause: error });
			return;
		}
		if (!released) scheduleHeartbeat();
	};
	scheduleHeartbeat();

	return {
		assertHeld() {
			if (compromised) throw compromised;
			if (released) throw new LockCompromisedError(directory);
		},
		async verifyHeld() {
			this.assertHeld();
			try { await assertOwnStamp(); }
			catch (error) {
				compromised = error instanceof LockCompromisedError ? error : new LockCompromisedError(directory, { cause: error });
				throw compromised;
			}
		},
		async release() {
			if (released) return;
			released = true;
			if (timer) clearTimeout(timer);
			heldDirectories.delete(directory);
			// A reclaimed directory belongs to another holder; removing it would break their lock.
			if (compromised) return;
			try { await rmdir(directory); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		},
	};
}

export async function acquireFileLock(targetPath: string, options: FileLockOptions = {}): Promise<HeldLock> {
	const directory = lockDirectoryFor(targetPath);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
	for (let attempt = 0; ; attempt++) {
		options.signal?.throwIfAborted();
		try {
			await mkdir(directory, { mode: 0o700 });
			return holdLock(directory, await stampHeartbeat(directory));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (await reclaimIfStale(directory, staleMs)) continue;
		if (Date.now() >= deadline) throw new LockTimeoutError(directory);
		await delay(Math.round(Math.min(10 * 2 ** attempt, MAX_BACKOFF_MS) * (1 + Math.random())), options.signal);
	}
}
