export interface OwnerIdentity {
	sessionId?: string;
	processId?: number;
}

export function ownerRecord(owner?: OwnerIdentity): { ownerSessionId?: string; ownerProcessId?: number } {
	return {
		...(owner?.sessionId ? { ownerSessionId: owner.sessionId } : {}),
		...(owner?.processId ? { ownerProcessId: owner.processId } : {}),
	};
}

export function isProcessAlive(pid: unknown): boolean {
	if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
	try { process.kill(Number(pid), 0); return true; }
	catch { return false; }
}
