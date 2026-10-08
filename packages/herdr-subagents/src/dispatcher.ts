interface QueuedRun<T> {
	id: string;
	execute: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

export interface DispatcherSnapshot {
	activeRunId?: string;
	queuedRunIds: string[];
}

export class RunDispatcher {
	private activeRunId?: string;
	private readonly queue: QueuedRun<unknown>[] = [];
	private readonly onChange?: (snapshot: DispatcherSnapshot) => void;
	private paused = false;
	private retainedRunId?: string;

	constructor(onChange?: (snapshot: DispatcherSnapshot) => void) { this.onChange = onChange; }

	submit<T>(id: string, execute: () => Promise<T>): Promise<T> {
		const promise = new Promise<T>((resolve, reject) => this.queue.push({ id, execute, resolve: resolve as (value: unknown) => void, reject }));
		this.changed();
		void this.drain();
		return promise;
	}

	snapshot(): DispatcherSnapshot {
		return { ...(this.activeRunId ? { activeRunId: this.activeRunId } : {}), queuedRunIds: this.queue.map((run) => run.id) };
	}

	pause(): void { this.paused = true; this.changed(); }
	resume(): void { this.paused = false; this.changed(); void this.drain(); }
	retain(id: string): void {
		if (this.activeRunId !== id) throw new Error(`Cannot retain inactive run '${id}'.`);
		this.retainedRunId = id;
		this.changed();
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
		for (const run of cancelled) run.reject(reason);
		this.changed();
		return cancelled.map((run) => run.id);
	}

	private changed(): void { this.onChange?.(this.snapshot()); }

	private async drain(): Promise<void> {
		if (this.activeRunId || this.paused) return;
		const run = this.queue.shift();
		if (!run) { this.changed(); return; }
		this.activeRunId = run.id;
		this.changed();
		try { run.resolve(await run.execute()); }
		catch (error) { run.reject(error); }
		finally {
			if (this.retainedRunId !== run.id) {
				this.activeRunId = undefined;
				this.changed();
				void this.drain();
			}
		}
	}
}
