export function isProcessAlive(pid: unknown): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try { process.kill(Number(pid), 0); return true; }
	catch { return false; }
}
