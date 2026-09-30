import { rename, writeFile } from "node:fs/promises";

export async function writeTextAtomic(path: string, content: string, mode = 0o600): Promise<void> {
	const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
	await writeFile(temporary, content, { encoding: "utf8", mode });
	await rename(temporary, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
