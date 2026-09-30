export function getBtwPageScrollSize(viewportHeight: number): number {
	return Math.max(1, Math.floor(viewportHeight));
}

export function clampBtwScrollTop(scrollTop: number, contentHeight: number, viewportHeight: number): number {
	const maxScrollTop = Math.max(0, Math.floor(contentHeight) - Math.floor(viewportHeight));
	const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : 0;
	return Math.max(0, Math.min(maxScrollTop, requested));
}
