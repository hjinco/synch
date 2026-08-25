import type { AlertConfig, MonitorEnv } from "./types";

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
	warmupSamples: 288,
	maxSamples: 288,
	counterRatio: 3,
	counterMin: 100,
	counterDelta: 200,
	gaugeRatio: 1.2,
	gaugeDeltaBytes: 1024 * 1024,
	requiredBreachWindows: 2,
	requiredRecoveryWindows: 2,
	cooldownMinutes: 30,
};

export function readAlertConfig(env: Pick<MonitorEnv, "ALERT_CONFIG">): AlertConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(env.ALERT_CONFIG);
	} catch (error) {
		throw new Error("ALERT_CONFIG must be valid JSON", { cause: error });
	}

	if (!isRecord(parsed)) {
		throw new Error("ALERT_CONFIG must be a JSON object");
	}

	const config: AlertConfig = {
		...DEFAULT_ALERT_CONFIG,
		...parsed,
	};
	validateAlertConfig(config);
	return config;
}

function validateAlertConfig(config: AlertConfig): void {
	const positiveIntegers: Array<keyof AlertConfig> = [
		"warmupSamples",
		"maxSamples",
		"counterMin",
		"counterDelta",
		"gaugeDeltaBytes",
		"requiredBreachWindows",
		"requiredRecoveryWindows",
		"cooldownMinutes",
	];
	for (const key of positiveIntegers) {
		const value = config[key];
		if (!Number.isInteger(value) || value < 1) {
			throw new Error(`ALERT_CONFIG.${key} must be a positive integer`);
		}
	}

	if (config.maxSamples < config.warmupSamples) {
		throw new Error("ALERT_CONFIG.maxSamples must be at least warmupSamples");
	}
	if (!Number.isFinite(config.counterRatio) || config.counterRatio <= 1) {
		throw new Error("ALERT_CONFIG.counterRatio must be greater than 1");
	}
	if (!Number.isFinite(config.gaugeRatio) || config.gaugeRatio <= 1) {
		throw new Error("ALERT_CONFIG.gaugeRatio must be greater than 1");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
