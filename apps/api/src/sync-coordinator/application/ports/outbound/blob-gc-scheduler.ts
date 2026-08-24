export interface BlobGcScheduler {
	scheduleAt(dueAt: number, now?: number): Promise<void>;
	scheduleNext(now?: number): Promise<number | null>;
	scheduleNow(now?: number): Promise<void>;
}
