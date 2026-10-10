interface QueuedRun<T> {
	id: string;
	execute: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	onRetained?: (retainedRunId: string) => T;
}

interface SubmitOptions<T> {
	signal?: AbortSignal;
	onRetained?: (retainedRunId: string) => T;
}

export interface DispatcherSnapshot {
	activeRunId?: string;
	retainedRunId?: string;
	queuedRunIds: string[];
}

export class RunDispatcher {
	private activeRunId?: string;
	private readonly queue: QueuedRun<unknown>[] = [];
	private readonly onChange?: (snapshot: DispatcherSnapshot) => void;
	private paused = false;
	private retainedRunId?: string;

	constructor(onChange?: (snapshot: DispatcherSnapshot) => void) { this.onChange = onChange; }

	submit<T>(id: string, execute: () => Promise<T>, options: SubmitOptions<T> = {}): Promise<T> {
		const { signal, onRetained } = options;
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error(`Queued run '${id}' was cancelled.`));
		if (this.retainedRunId && onRetained) return Promise.resolve(onRetained(this.retainedRunId));
		const promise = new Promise<T>((resolve, reject) => {
			const queued: QueuedRun<T> = { id, execute, resolve, reject, signal, onRetained };
			queued.onAbort = () => {
				const index = this.queue.indexOf(queued as QueuedRun<unknown>);
				if (index < 0) return;
				this.queue.splice(index, 1);
				reject(signal?.reason ?? new Error(`Queued run '${id}' was cancelled.`));
				this.changed();
			};
			signal?.addEventListener("abort", queued.onAbort, { once: true });
			this.queue.push(queued as QueuedRun<unknown>);
		});
		this.changed();
		void this.drain();
		return promise;
	}

	snapshot(): DispatcherSnapshot {
		return {
			...(this.activeRunId ? { activeRunId: this.activeRunId } : {}),
			...(this.retainedRunId ? { retainedRunId: this.retainedRunId } : {}),
			queuedRunIds: this.queue.map((run) => run.id),
		};
	}

	pause(): void { this.paused = true; this.changed(); }
	resume(): void { this.paused = false; this.changed(); void this.drain(); }
	retain(id: string): void {
		if (this.activeRunId !== id) throw new Error(`Cannot retain inactive run '${id}'.`);
		this.retainedRunId = id;
		for (let index = this.queue.length - 1; index >= 0; index -= 1) {
			const queued = this.queue[index];
			if (!queued.onRetained) continue;
			this.queue.splice(index, 1);
			if (queued.onAbort) queued.signal?.removeEventListener("abort", queued.onAbort);
			try { queued.resolve(queued.onRetained(id)); }
			catch (error) { queued.reject(error); }
		}
		this.changed();
	}
	detach(id: string): boolean {
		if (this.activeRunId !== id || this.retainedRunId === id) return false;
		this.activeRunId = undefined;
		this.changed();
		void this.drain();
		return true;
	}
	release(id: string): boolean {
		if (this.activeRunId !== id || this.retainedRunId !== id) return false;
		this.retainedRunId = undefined;
		this.activeRunId = undefined;
		this.changed();
		void this.drain();
		return true;
	}
	cancelQueued(reason: Error): string[] {
		const cancelled = this.queue.splice(0);
		for (const run of cancelled) {
			if (run.onAbort) run.signal?.removeEventListener("abort", run.onAbort);
			run.reject(reason);
		}
		this.changed();
		return cancelled.map((run) => run.id);
	}
	cancelQueuedRun(id: string, reason: Error): boolean {
		const index = this.queue.findIndex((run) => run.id === id);
		if (index < 0) return false;
		const [cancelled] = this.queue.splice(index, 1);
		if (cancelled.onAbort) cancelled.signal?.removeEventListener("abort", cancelled.onAbort);
		cancelled.reject(reason);
		this.changed();
		return true;
	}

	private changed(): void { this.onChange?.(this.snapshot()); }

	private async drain(): Promise<void> {
		if (this.activeRunId || this.paused) return;
		const run = this.queue.shift();
		if (!run) { this.changed(); return; }
		if (run.onAbort) run.signal?.removeEventListener("abort", run.onAbort);
		this.activeRunId = run.id;
		this.changed();
		try { run.resolve(await run.execute()); }
		catch (error) { run.reject(error); }
		finally {
			if (this.activeRunId === run.id && this.retainedRunId !== run.id) {
				this.activeRunId = undefined;
				this.changed();
				void this.drain();
			}
		}
	}
}
