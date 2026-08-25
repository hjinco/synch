import type {
	AlertConfig,
	AlertEvent,
	MetricEvaluation,
	MetricSample,
	MetricState,
	StoredSample,
} from "./types";

export function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

export function evaluateMetric(
	state: MetricState,
	sample: MetricSample,
	config: AlertConfig,
	now: number,
): MetricEvaluation {
	if (
		state.lastProcessedWindowEnd !== undefined &&
		sample.windowEnd <= state.lastProcessedWindowEnd
	) {
		return {
			nextState: state,
			ignored: true,
		};
	}

	const baseline = median(state.samples.map((item) => item.value));
	const nextSamples = appendSample(state.samples, sample, config.maxSamples);
	const nextState: MetricState = {
		...state,
		samples: nextSamples,
		lastProcessedWindowEnd: sample.windowEnd,
	};

	if (baseline === undefined || state.samples.length < config.warmupSamples) {
		return {
			nextState: {
				...nextState,
				breachWindows: 0,
				normalWindows: 0,
			},
			baseline,
			ignored: false,
		};
	}

	const ratio = baseline > 0 ? sample.value / baseline : null;
	const breached = isBreached(sample, baseline, config);
	if (breached) {
		nextState.normalWindows = 0;
		nextState.breachWindows = state.breachWindows + 1;
		if (
			state.phase === "normal" &&
			nextState.breachWindows >= config.requiredBreachWindows &&
			canAlert(state.lastAlertAt, now, config.cooldownMinutes)
		) {
			return {
				nextState,
				event: createEvent("start", sample, baseline, ratio),
				baseline,
				ignored: false,
			};
		}
		return { nextState, baseline, ignored: false };
	}

	nextState.breachWindows = 0;
	if (state.phase === "firing") {
		nextState.normalWindows = state.normalWindows + 1;
		if (nextState.normalWindows >= config.requiredRecoveryWindows) {
			return {
				nextState,
				event: createEvent("recovery", sample, baseline, ratio),
				baseline,
				ignored: false,
			};
		}
	} else {
		nextState.normalWindows = 0;
	}

	return { nextState, baseline, ignored: false };
}

export function commitTransition(
	state: MetricState,
	transition: AlertEvent["transition"],
	now: number,
): MetricState {
	if (transition === "start") {
		return {
			...state,
			phase: "firing",
			breachWindows: 0,
			normalWindows: 0,
			lastAlertAt: now,
		};
	}
	return {
		...state,
		phase: "normal",
		breachWindows: 0,
		normalWindows: 0,
		lastAlertAt: now,
	};
}

function appendSample(
	samples: StoredSample[],
	sample: MetricSample,
	maxSamples: number,
): StoredSample[] {
	return [
		...samples,
		{ windowEnd: sample.windowEnd, value: sample.value },
	].slice(-maxSamples);
}

function isBreached(
	sample: MetricSample,
	baseline: number,
	config: AlertConfig,
): boolean {
	if (sample.kind === "counter") {
		return (
			sample.value >= config.counterMin &&
			sample.value - baseline >= config.counterDelta &&
			sample.value >= baseline * config.counterRatio
		);
	}
	return (
		sample.value >= baseline * config.gaugeRatio &&
		sample.value - baseline >= config.gaugeDeltaBytes
	);
}

function canAlert(
	lastAlertAt: number | undefined,
	now: number,
	cooldownMinutes: number,
): boolean {
	return (
		lastAlertAt === undefined ||
		now - lastAlertAt >= cooldownMinutes * 60 * 1000
	);
}

function createEvent(
	transition: AlertEvent["transition"],
	metric: MetricSample,
	baseline: number,
	ratio: number | null,
): AlertEvent {
	return {
		transition,
		metric,
		baseline,
		ratio,
		windowEnd: metric.windowEnd,
	};
}
