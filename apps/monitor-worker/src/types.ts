export const METRIC_IDS = [
	"workers.requests",
	"r2.operations",
	"r2.storageBytes",
	"durable_objects.requests",
	"durable_objects.storageBytes",
] as const;

export type MetricId = (typeof METRIC_IDS)[number];
export type MetricKind = "counter" | "gauge";
export type AlertPhase = "normal" | "firing";
export type AlertTransition = "start" | "recovery";

export interface MetricSample {
	id: MetricId;
	kind: MetricKind;
	value: number;
	observedAt: string;
	windowStart: string;
	windowEnd: string;
}

export interface StoredSample {
	windowEnd: string;
	value: number;
}

export interface MetricState {
	samples: StoredSample[];
	phase: AlertPhase;
	breachWindows: number;
	normalWindows: number;
	lastAlertAt?: number;
	lastProcessedWindowEnd?: string;
}

export interface MonitorState {
	version: 1;
	metrics: Record<MetricId, MetricState>;
	monitorFailures: number;
	monitorFailureAlerted: boolean;
}

export interface AlertConfig {
	warmupSamples: number;
	maxSamples: number;
	counterRatio: number;
	counterMin: number;
	counterDelta: number;
	gaugeRatio: number;
	gaugeDeltaBytes: number;
	requiredBreachWindows: number;
	requiredRecoveryWindows: number;
	cooldownMinutes: number;
}

export interface AlertEvent {
	transition: AlertTransition;
	metric: MetricSample;
	baseline: number;
	ratio: number | null;
	windowEnd: string;
}

export interface MetricEvaluation {
	nextState: MetricState;
	event?: AlertEvent;
	baseline?: number;
	ignored: boolean;
}

export interface MonitorEnv {
	CLOUDFLARE_ACCOUNT_ID: string;
	TARGET_WORKER: string;
	TARGET_R2_BUCKET: string;
	TARGET_DO_NAMESPACE_ID: string;
	ALERT_CONFIG: string;
	CF_ANALYTICS_TOKEN: string;
	DISCORD_WEBHOOK_URL: string;
	MONITOR_STATE: KVNamespace;
}

export interface MonitorSnapshot {
	samples: MetricSample[];
	missing: MetricId[];
}
