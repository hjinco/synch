import { METRIC_IDS, type MetricId, type MetricState, type MonitorEnv, type MonitorState } from "./types";

const STATE_KEY = "monitor-state:v1";

export function emptyMetricState(): MetricState {
	return {
		samples: [],
		phase: "normal",
		breachWindows: 0,
		normalWindows: 0,
	};
}

export function emptyMonitorState(): MonitorState {
	return {
		version: 1,
		metrics: Object.fromEntries(
			METRIC_IDS.map((id) => [id, emptyMetricState()]),
		) as Record<MetricId, MetricState>,
		monitorFailures: 0,
		monitorFailureAlerted: false,
	};
}

export async function readMonitorState(env: Pick<MonitorEnv, "MONITOR_STATE">): Promise<MonitorState> {
	const state = await env.MONITOR_STATE.get<MonitorState>(STATE_KEY, "json");
	if (!state) return emptyMonitorState();
	return normalizeMonitorState(state);
}

export async function writeMonitorState(
	env: Pick<MonitorEnv, "MONITOR_STATE">,
	state: MonitorState,
): Promise<void> {
	await env.MONITOR_STATE.put(STATE_KEY, JSON.stringify(normalizeMonitorState(state)));
}

function normalizeMonitorState(state: MonitorState): MonitorState {
	const initial = emptyMonitorState();
	return {
		version: 1,
		metrics: Object.fromEntries(
			METRIC_IDS.map((id) => [id, state.metrics?.[id] ?? initial.metrics[id]]),
		) as Record<MetricId, MetricState>,
		monitorFailures: Number.isInteger(state.monitorFailures) && state.monitorFailures >= 0
			? state.monitorFailures
			: 0,
		monitorFailureAlerted: state.monitorFailureAlerted === true,
	};
}
