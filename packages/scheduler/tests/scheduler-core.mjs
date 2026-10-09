import assert from "node:assert/strict";
import { Scheduler, parseDuration } from "../src/scheduler.ts";

class FakeClock {
	nowMs = 1_000_000;
	nextHandle = 1;
	timers = new Map();
	now() { return this.nowMs; }
	setTimeout(callback, delayMs) {
		const handle = this.nextHandle++;
		this.timers.set(handle, { at: this.nowMs + delayMs, callback });
		return handle;
	}
	clearTimeout(handle) { this.timers.delete(handle); }
	advance(ms) {
		this.nowMs += ms;
		while (true) {
			const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.nowMs).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

assert.equal(parseDuration("5m"), 300_000);
assert.equal(parseDuration("1h30m"), 5_400_000);
assert.throws(() => parseDuration("cron * * * * *"), /interval/);
assert.throws(() => parseDuration("500ms"), /between 1s and 7d/);

const clock = new FakeClock();
const triggers = [];
let changes = 0;
const scheduler = new Scheduler({ clock, onTrigger: (schedule, source) => triggers.push({ schedule, source }), onChange: () => { changes += 1; } });
const added = scheduler.add("5m", "Check CI and report only if finished or failed");
assert.equal(added.id, "schedule-1");
assert.equal(added.nextRunAt, 1_300_000);
assert.equal(scheduler.list().length, 1);

clock.advance(300_000);
assert.equal(triggers.length, 1);
assert.equal(triggers[0].source, "timer");
assert.equal(scheduler.list()[0].pending, true);
assert.equal(scheduler.list()[0].nextRunAt, 1_600_000);

clock.advance(900_000);
assert.equal(triggers.length, 1, "missed intervals coalesce while one prompt is pending");
assert.equal(scheduler.list()[0].nextRunAt, 2_500_000, "absolute cadence skips missed intervals without drift");
assert.equal(scheduler.acknowledge(added.id), true);
assert.equal(scheduler.acknowledge(added.id), false);
assert.equal(scheduler.trigger(added.id).ok, true);
assert.equal(triggers.at(-1).source, "manual");
assert.equal(scheduler.list()[0].nextRunAt, 2_500_000, "manual trigger preserves regular cadence");
assert.deepEqual(scheduler.trigger(added.id).reason, "already-pending");
assert.equal(scheduler.releaseUndelivered(), 1);
assert.equal(scheduler.releaseUndelivered(), 0);
assert.equal(scheduler.trigger(added.id).ok, true, "a settled run releases a follow-up that never entered message_start");

assert.equal(scheduler.cancel(added.id), true);
assert.equal(scheduler.cancel(added.id), false);
assert.equal(scheduler.list().length, 0);
const firstClear = scheduler.add("1h", "Check build");
const secondClear = scheduler.add("2h", "Check deployment");
assert.notEqual(firstClear.id, secondClear.id);
assert.equal(clock.timers.size, 2);
assert.equal(scheduler.clear(), 2);
assert.equal(clock.timers.size, 0, "clear cancels every timer");
assert.equal(scheduler.clear(), 0);
assert.ok(changes >= 5);
console.log("Scheduler core tests passed");
