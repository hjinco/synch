export type MaintenanceJobKey = "blob_gc" | "health_summary_flush";
export type MaintenanceJobHandler = (now: number) => Promise<number | null>;
export type MaintenanceJobHandlers = Record<MaintenanceJobKey, MaintenanceJobHandler>;

export interface MaintenanceScheduler {
	defer(key: MaintenanceJobKey, dueAt: number, now?: number): Promise<void>;
}

export interface MaintenanceRunner {
	drain(handlers: MaintenanceJobHandlers, now?: number): Promise<void>;
}
