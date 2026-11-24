import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isRecord } from "./transport.ts";

export type CageProfile = Readonly<{ executable: string; config: string; servicePath: string }>;

const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_CATALOG_BYTES = 512 * 1024;

function readJson(path: string, limit: number): unknown {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.size > limit) throw new Error("Not a bounded regular file");
		const buffer = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < buffer.length) {
			const bytes = readSync(descriptor, buffer, length, buffer.length - length, null);
			if (bytes === 0) break;
			length += bytes;
		}
		if (length > limit) throw new Error("File is too large");
		return JSON.parse(buffer.toString("utf8", 0, length));
	} finally {
		closeSync(descriptor);
	}
}

function absolutePath(value: unknown): value is string {
	return typeof value === "string" && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
}

export function loadProfile(agentDir: string): CageProfile {
	const path = join(agentDir, "claude-cage.json");
	let data: unknown;
	try {
		data = readJson(path, MAX_CONFIG_BYTES);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new Error(code === "ENOENT" ? `Create ${path} first` : `Cannot read a valid JSON profile from ${path}`);
	}
	if (isRecord(data) && Object.hasOwn(data, "clientPath")) {
		throw new Error(`${path} uses the old clientPath schema; replace clientPath with the guest servicePath and run /reload`);
	}
	if (!isRecord(data) || Object.keys(data).length !== 3 ||
		!absolutePath(data.executable) || !absolutePath(data.config) || !absolutePath(data.servicePath)) {
		throw new Error(`${path} must contain executable, config, and servicePath as absolute paths`);
	}
	return Object.freeze({ executable: data.executable, config: data.config, servicePath: data.servicePath });
}

function profileKey(profile: CageProfile) {
	return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

export function loadCatalog(agentDir: string, profile: CageProfile): unknown {
	try {
		const data = readJson(join(agentDir, "claude-cage-models.json"), MAX_CATALOG_BYTES);
		if (isRecord(data) && data.profile === profileKey(profile)) return data.models;
	} catch {
		// A missing or invalid cache does not initiate discovery.
	}
}

export function saveCatalog(agentDir: string, profile: CageProfile, models: readonly object[]) {
	const path = join(agentDir, "claude-cage-models.json");
	const temp = `${path}.${randomUUID()}.tmp`;
	const data = JSON.stringify({ profile: profileKey(profile), models });
	if (Buffer.byteLength(data) > MAX_CATALOG_BYTES) throw new Error("The Cage model catalog is too large to cache");
	try {
		writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}
