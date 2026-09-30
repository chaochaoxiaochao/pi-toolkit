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

	private changed(): void { this.onChange?.(this.snapshot()); }

	private async drain(): Promise<void> {
		if (this.activeRunId) return;
		const run = this.queue.shift();
		if (!run) { this.changed(); return; }
		this.activeRunId = run.id;
		this.changed();
		try { run.resolve(await run.execute()); }
		catch (error) { run.reject(error); }
		finally { this.activeRunId = undefined; this.changed(); void this.drain(); }
	}
}
