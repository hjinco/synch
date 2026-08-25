import { readAlertConfig } from "./config";
import {
	readCloudflareMetrics,
	type AnalyticsWindow,
} from "./cloudflare-analytics";
import {
	commitTransition,
	evaluateMetric,
} from "./alert-evaluator";
import {
	sendDiscordAlert,
	sendMonitorHealthAlert,
} from "./discord";
import { readMonitorState, writeMonitorState } from "./state";
import type {
	AlertEvent,
	MetricEvaluation,
	MetricId,
	MonitorEnv,
	MonitorSnapshot,
} from "./types";

export interface MonitorDependencies {
	readMetrics: (
		env: MonitorEnv,
		window: AnalyticsWindow,
	) => Promise<MonitorSnapshot>;
	sendAlert: (
		env: Pick<MonitorEnv, "DISCORD_WEBHOOK_URL">,
		events: AlertEvent[],
		samples: MonitorSnapshot["samples"],
	) => Promise<void>;
	sendHealthAlert: (
		env: Pick<MonitorEnv, "DISCORD_WEBHOOK_URL">,
		title: string,
		description: string,
	) => Promise<void>;
}

const defaultDependencies: MonitorDependencies = {
	readMetrics: readCloudflareMetrics,
	sendAlert: sendDiscordAlert,
	sendHealthAlert: sendMonitorHealthAlert,
};

export default {
	async scheduled(controller: ScheduledController, env: MonitorEnv): Promise<void> {
		await runMonitorCycle(env, controller.scheduledTime);
	},
};

export async function runMonitorCycle(
	env: MonitorEnv,
	scheduledTime: number,
	dependencies: MonitorDependencies = defaultDependencies,
): Promise<void> {
	const window = createAnalyticsWindow(scheduledTime);
	let config;
	try {
		config = readAlertConfig(env);
	} catch (error) {
		logError("alert_config_invalid", error);
		return;
	}
	let state;
	try {
		state = await readMonitorState(env);
	} catch (error) {
		logError("state_read_failed", error);
		return;
	}

	let snapshot: MonitorSnapshot;
	try {
		snapshot = await dependencies.readMetrics(env, window);
	} catch (error) {
		await recordMonitorFailure(env, state, error, dependencies);
		return;
	}

	if (snapshot.missing.length > 0) {
		console.warn(
			JSON.stringify({
				event: "monitor_metrics_missing",
				metricIds: snapshot.missing,
				windowEnd: window.end.toISOString(),
			}),
		);
	}

	state.monitorFailures = 0;
	if (state.monitorFailureAlerted) {
		try {
			await dependencies.sendHealthAlert(
				env,
				"✅ Cloudflare monitor recovered",
				"Cloudflare Analytics 조회가 다시 성공했습니다.",
			);
			state.monitorFailureAlerted = false;
		} catch (error) {
			logError("monitor_health_recovery_notification_failed", error);
		}
	}

	const evaluations = new Map<MetricId, MetricEvaluation>();
	const events: AlertEvent[] = [];
	for (const sample of snapshot.samples) {
		const evaluation = evaluateMetric(
			state.metrics[sample.id],
			sample,
			config,
			scheduledTime,
		);
		if (evaluation.ignored) continue;
		evaluations.set(sample.id, evaluation);
		if (evaluation.event) events.push(evaluation.event);
	}

	if (events.length > 0) {
		try {
			await dependencies.sendAlert(env, events, snapshot.samples);
			for (const event of events) {
				const evaluation = evaluations.get(event.metric.id);
				if (!evaluation) continue;
				evaluation.nextState = commitTransition(
					evaluation.nextState,
					event.transition,
					scheduledTime,
				);
			}
		} catch (error) {
			logError("discord_alert_failed", error);
		}
	}

	for (const [metricId, evaluation] of evaluations) {
		state.metrics[metricId] = evaluation.nextState;
	}

	try {
		await writeMonitorState(env, state);
	} catch (error) {
		logError("state_write_failed", error);
	}
}

export function createAnalyticsWindow(scheduledTime: number): AnalyticsWindow {
	const end = new Date(scheduledTime - 5 * 60 * 1000);
	const start = new Date(scheduledTime - 10 * 60 * 1000);
	return { start, end };
}

async function recordMonitorFailure(
	env: MonitorEnv,
	state: Awaited<ReturnType<typeof readMonitorState>>,
	error: unknown,
	dependencies: MonitorDependencies,
): Promise<void> {
	state.monitorFailures += 1;
	logError("cloudflare_metrics_failed", error, {
		consecutiveFailures: state.monitorFailures,
	});

	if (state.monitorFailures >= 3 && !state.monitorFailureAlerted) {
		try {
			await dependencies.sendHealthAlert(
				env,
				"⚠️ Cloudflare monitor degraded",
				`Cloudflare Analytics 조회가 ${state.monitorFailures}회 연속 실패했습니다.`,
			);
			state.monitorFailureAlerted = true;
		} catch (notificationError) {
			logError("monitor_health_notification_failed", notificationError);
		}
	}

	try {
		await writeMonitorState(env, state);
	} catch (writeError) {
		logError("state_write_failed_after_monitor_failure", writeError);
	}
}

function logError(
	event: string,
	error: unknown,
	extra: Record<string, unknown> = {},
): void {
	console.error(
		JSON.stringify({
			event,
			error: error instanceof Error
				? { name: error.name, message: error.message, stack: error.stack }
				: { message: String(error) },
			...extra,
		}),
	);
}
