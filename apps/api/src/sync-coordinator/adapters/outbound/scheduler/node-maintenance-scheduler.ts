import type { CoordinatorStorageHandle } from "../sqlite/storage-handle";
import {
	PersistentMaintenanceScheduler,
	type MaintenanceAlarm,
} from "./persistent-maintenance-scheduler";

// Node reduces delays above the signed 32-bit limit to 1 ms.
const MAX_TIMEOUT_MS = 2_147_483_647;

/** One process-local wake-up timer per vault; jobs themselves remain in SQLite. */
class NodeMaintenanceAlarm implements MaintenanceAlarm {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private armedFor: number | null = null;

	constructor(private readonly onAlarmDue: () => Promise<void>) {}

	getAlarm(): number | null {
		return this.armedFor;
	}

	setAlarm(at: number): void {
		this.deleteAlarm();
		this.armedFor = at;
		const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, at - Date.now()));
		this.timer = setTimeout(() => {
			this.timer = null;
			if (Date.now() < at) {
				this.setAlarm(at);
				return;
			}
			this.armedFor = null;
			void this.onAlarmDue();
		}, delay);
	}

	deleteAlarm(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.armedFor = null;
	}
}

export class NodeMaintenanceScheduler extends PersistentMaintenanceScheduler {
	private readonly nodeAlarm: NodeMaintenanceAlarm;

	constructor(handle: CoordinatorStorageHandle, onAlarmDue: () => Promise<void>) {
		const alarm = new NodeMaintenanceAlarm(onAlarmDue);
		super(handle, alarm, "[node-coordinator]");
		this.nodeAlarm = alarm;
	}

	/** Retry a failed alarm invocation independently of individual job due dates. */
	retryAfter(delayMs: number): void {
		this.nodeAlarm.setAlarm(Date.now() + delayMs);
	}

	/** Release the timer without deleting durable work so restart can recover it. */
	dispose(): void {
		this.nodeAlarm.deleteAlarm();
	}
}
