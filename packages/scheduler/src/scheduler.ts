export interface Clock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ScheduleSnapshot {
	id: string;
	every: string;
	intervalMs: number;
	prompt: string;
	nextRunAt: number;
	pending: boolean;
}

interface Schedule extends ScheduleSnapshot {
	timer?: unknown;
}

export interface TriggerResult {
	ok: boolean;
	reason?: "not-found" | "already-pending";
	schedule?: ScheduleSnapshot;
}

const DURATION_PART = /(\d+)(ms|s|m|h|d)/gy;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function parseDuration(input: string): number {
	const value = input.trim().toLowerCase();
	if (!value) throw new Error("interval is required");
	let total = 0;
	let offset = 0;
	for (const match of value.matchAll(DURATION_PART)) {
		if (match.index !== offset) throw new Error(`invalid interval: ${input}`);
		const amount = Number(match[1]);
		const unit = match[2];
		const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
		total += amount * multiplier;
		offset = match.index + match[0].length;
	}
	if (offset !== value.length || total < 1_000 || total > MAX_INTERVAL_MS) {
		throw new Error("interval must be between 1s and 7d (examples: 30s, 5m, 1h30m)");
	}
	return total;
}

export class Scheduler {
	private readonly clock: Clock;
	private readonly onTrigger: (schedule: ScheduleSnapshot, source: "timer" | "manual") => void;
	private readonly onChange: () => void;
	private readonly schedules = new Map<string, Schedule>();
	private nextId = 1;

	constructor(options: {
		clock: Clock;
		onTrigger: (schedule: ScheduleSnapshot, source: "timer" | "manual") => void;
		onChange?: () => void;
	}) {
		this.clock = options.clock;
		this.onTrigger = options.onTrigger;
		this.onChange = options.onChange ?? (() => {});
	}

	add(every: string, prompt: string): ScheduleSnapshot {
		const intervalMs = parseDuration(every);
		const normalizedPrompt = prompt.trim();
		if (!normalizedPrompt) throw new Error("prompt is required");
		const schedule: Schedule = {
			id: `schedule-${this.nextId++}`,
			every: every.trim(),
			intervalMs,
			prompt: normalizedPrompt,
			nextRunAt: this.clock.now() + intervalMs,
			pending: false,
		};
		this.schedules.set(schedule.id, schedule);
		this.arm(schedule);
		this.onChange();
		return this.snapshot(schedule);
	}

	list(): ScheduleSnapshot[] {
		return [...this.schedules.values()]
			.sort((left, right) => left.nextRunAt - right.nextRunAt || left.id.localeCompare(right.id))
			.map((schedule) => this.snapshot(schedule));
	}

	trigger(id: string): TriggerResult {
		const schedule = this.schedules.get(id);
		if (!schedule) return { ok: false, reason: "not-found" };
		if (schedule.pending) return { ok: false, reason: "already-pending", schedule: this.snapshot(schedule) };
		this.fire(schedule, "manual");
		return { ok: true, schedule: this.snapshot(schedule) };
	}

	cancel(id: string): boolean {
		const schedule = this.schedules.get(id);
		if (!schedule) return false;
		if (schedule.timer !== undefined) this.clock.clearTimeout(schedule.timer);
		this.schedules.delete(id);
		this.onChange();
		return true;
	}

	acknowledge(id: string): boolean {
		const schedule = this.schedules.get(id);
		if (!schedule?.pending) return false;
		schedule.pending = false;
		this.onChange();
		return true;
	}

	releaseUndelivered(): number {
		let released = 0;
		for (const schedule of this.schedules.values()) {
			if (!schedule.pending) continue;
			schedule.pending = false;
			released += 1;
		}
		if (released > 0) this.onChange();
		return released;
	}

	clear(): void {
		for (const schedule of this.schedules.values()) {
			if (schedule.timer !== undefined) this.clock.clearTimeout(schedule.timer);
		}
		this.schedules.clear();
		this.onChange();
	}

	private arm(schedule: Schedule): void {
		const delay = Math.max(0, schedule.nextRunAt - this.clock.now());
		schedule.timer = this.clock.setTimeout(() => this.tick(schedule.id), delay);
	}

	private tick(id: string): void {
		const schedule = this.schedules.get(id);
		if (!schedule) return;
		const now = this.clock.now();
		do schedule.nextRunAt += schedule.intervalMs;
		while (schedule.nextRunAt <= now);
		if (!schedule.pending) this.fire(schedule, "timer");
		this.arm(schedule);
		this.onChange();
	}

	private fire(schedule: Schedule, source: "timer" | "manual"): void {
		schedule.pending = true;
		this.onTrigger(this.snapshot(schedule), source);
		this.onChange();
	}

	private snapshot(schedule: Schedule): ScheduleSnapshot {
		return {
			id: schedule.id,
			every: schedule.every,
			intervalMs: schedule.intervalMs,
			prompt: schedule.prompt,
			nextRunAt: schedule.nextRunAt,
			pending: schedule.pending,
		};
	}
}

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
