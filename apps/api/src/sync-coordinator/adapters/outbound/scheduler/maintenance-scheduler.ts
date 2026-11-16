import { PersistentMaintenanceScheduler } from "./persistent-maintenance-scheduler";

export type {
	MaintenanceJobHandler,
	MaintenanceJobHandlers,
	MaintenanceJobKey,
	MaintenanceRunner,
	MaintenanceScheduler,
} from "../../../application/ports/outbound";

/** Cloudflare wakes the shared durable scheduler through its alarm API. */
export class CoordinatorMaintenanceScheduler extends PersistentMaintenanceScheduler {
	constructor(ctx: DurableObjectState) {
		super(
			ctx.storage.sql,
			{
				getAlarm: () => ctx.storage.getAlarm(),
				setAlarm: (at) => ctx.storage.setAlarm(at),
				deleteAlarm: async () => { await ctx.storage.deleteAlarm(); },
			},
			"[sync-coordinator]",
		);
	}
}
