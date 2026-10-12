import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isProcessAlive } from "./ownership.ts";
import { readRunRecord, type RunRecord } from "./records.ts";
import { writeJsonAtomic } from "./state.ts";

interface LockOwner {
	token: string;
	processId: number;
	createdAt: string;
}

export interface DirectoryLock {
	directory: string;
	token: string;
	release(): Promise<void>;
}

const INITIALIZATION_STALE_MS = 30_000;
const delay = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Lock wait aborted.")); };
	const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
});

async function readOwner(directory: string): Promise<LockOwner | undefined> {
	try {
		const value = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")) as Partial<LockOwner>;
		if (typeof value.token === "string" && Number.isInteger(value.processId)) return { ...value, createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString() } as LockOwner;
	} catch { /* An invalid/legacy lock is handled only after its initialization lease expires. */ }
	return undefined;
}

async function reclaimIfStale(directory: string): Promise<boolean> {
	const owner = await readOwner(directory);
	if (owner && isProcessAlive(owner.processId)) return false;
	let identity;
	try { identity = await lstat(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
	// A missing owner is an explicit initialization state. Atomic publication below does
	// not create it, but retain a lease for old/crashed lock directories.
	if (!owner && Date.now() - identity.mtimeMs < INITIALIZATION_STALE_MS) return false;
	const stale = `${directory}.stale-${randomUUID()}`;
	// Revalidate both ownership and directory identity immediately before reclamation.
	const latestOwner = await readOwner(directory);
	if (latestOwner && isProcessAlive(latestOwner.processId)) return false;
	let latestIdentity;
	try { latestIdentity = await lstat(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
	if (latestIdentity.dev !== identity.dev || latestIdentity.ino !== identity.ino) return true;
	try { await rename(directory, stale); }
	catch (error) {
		if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String((error as NodeJS.ErrnoException).code))) return true;
		throw error;
	}
	await rm(stale, { recursive: true, force: true });
	return true;
}

export async function acquireDirectoryLock(directory: string, options: { wait: boolean; signal?: AbortSignal; contentionMessage?: string; beforePublish?: () => void | Promise<void> }): Promise<DirectoryLock> {
	const token = randomUUID();
	const owner: LockOwner = { token, processId: process.pid, createdAt: new Date().toISOString() };
	for (;;) {
		const prepared = `${directory}.initializing-${token}`;
		await mkdir(prepared, { mode: 0o700 });
		try {
			await writeJsonAtomic(join(prepared, "owner.json"), owner);
			await options.beforePublish?.();
			try { await rename(prepared, directory); }
			catch (error) {
				if (!["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
				await rm(prepared, { recursive: true, force: true });
				if (await reclaimIfStale(directory)) continue;
				if (!options.wait) throw new Error(options.contentionMessage ?? `Lock is already held: ${directory}`);
				await delay(10, options.signal);
				continue;
			}
			return {
				directory,
				token,
				async release() {
					if ((await readOwner(directory))?.token !== token) return;
					const released = `${directory}.released-${token}`;
					try { await rename(directory, released); }
					catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
					// Delete only the detached inode; a contender may safely publish the next
					// generation at the canonical path immediately after the rename.
					await rm(released, { recursive: true, force: true });
				}, 
			};
		} catch (error) {
			await rm(prepared, { recursive: true, force: true });
			throw error;
		}
	}
}

/** Only the holder of this lock may start a run's queued tasks. */
export function queueLockPath(runDirectory: string): string { return join(runDirectory, ".queue.lock"); }

/** Replaces a long-lived in-memory copy with the record observed under the lock, including removals. */
export function adoptRecord<T extends object>(target: T, latest: T): T {
	const mutable = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(mutable)) if (!(key in latest)) delete mutable[key];
	return Object.assign(target, latest);
}

export async function withRunStateLock<T>(runFile: string, signal: AbortSignal | undefined, mutate: (run: RunRecord) => T | Promise<T>): Promise<T> {
	const lock = await acquireDirectoryLock(join(dirname(runFile), ".state.lock"), { wait: true, signal });
	try {
		const run = await readRunRecord(runFile);
		const result = await mutate(run);
		await writeJsonAtomic(runFile, run);
		return result;
	} finally {
		await lock.release();
	}
}
