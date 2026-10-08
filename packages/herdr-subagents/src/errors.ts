export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)));
}
