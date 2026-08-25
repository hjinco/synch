import { describe, expect, it } from "vitest";

import {
	commitTransition,
	evaluateMetric,
	median,
} from "../src/alert-evaluator";
import { emptyMetricState } from "../src/state";
import type { AlertConfig, MetricSample, MetricState } from "../src/types";

const config: AlertConfig = {
	warmupSamples: 3,
	maxSamples: 3,
	counterRatio: 3,
	counterMin: 100,
	counterDelta: 200,
	gaugeRatio: 1.2,
	gaugeDeltaBytes: 1024 * 1024,
	requiredBreachWindows: 2,
	requiredRecoveryWindows: 2,
	cooldownMinutes: 30,
};

describe("alert evaluator", () => {
	it("uses the median rather than the mean", () => {
		expect(median([1, 2, 100])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
	});

	it("warms up before evaluating a counter", () => {
		const state = emptyMetricState();
		const first = evaluateMetric(state, counterSample(100, "1"), config, 0);
		const second = evaluateMetric(first.nextState, counterSample(100, "2"), config, 1);
		const third = evaluateMetric(second.nextState, counterSample(100, "3"), config, 2);

		expect(first.event).toBeUndefined();
		expect(second.event).toBeUndefined();
		expect(third.event).toBeUndefined();
		expect(third.nextState.samples).toHaveLength(3);
	});

	it("requires two consecutive counter breaches before starting an alert", () => {
		const state: MetricState = {
			...emptyMetricState(),
			samples: [
				{ windowEnd: "1", value: 100 },
				{ windowEnd: "2", value: 100 },
				{ windowEnd: "3", value: 100 },
			],
		};
		const first = evaluateMetric(state, counterSample(400, "4"), config, 0);
		const second = evaluateMetric(first.nextState, counterSample(500, "5"), config, 1);

		expect(first.event).toBeUndefined();
		expect(second.event?.transition).toBe("start");
		expect(second.nextState.phase).toBe("normal");

		const firing = commitTransition(second.nextState, "start", 1);
		expect(firing.phase).toBe("firing");
	});

	it("does not flag a low-volume ratio spike", () => {
		const state: MetricState = {
			...emptyMetricState(),
			samples: [
				{ windowEnd: "1", value: 1 },
				{ windowEnd: "2", value: 1 },
				{ windowEnd: "3", value: 1 },
			],
		};

		const evaluation = evaluateMetric(state, counterSample(4, "4"), config, 0);
		expect(evaluation.nextState.breachWindows).toBe(0);
		expect(evaluation.event).toBeUndefined();
	});

	it("honors the cooldown before a new start transition", () => {
		const state: MetricState = {
			...emptyMetricState(),
			lastAlertAt: 0,
			samples: [
				{ windowEnd: "1", value: 100 },
				{ windowEnd: "2", value: 100 },
				{ windowEnd: "3", value: 100 },
			],
		};
		const first = evaluateMetric(state, counterSample(400, "4"), config, 1);
		const second = evaluateMetric(first.nextState, counterSample(500, "5"), config, 2);
		const afterCooldown = evaluateMetric(
			second.nextState,
			counterSample(2000, "6"),
			config,
			31 * 60 * 1000,
		);

		expect(first.event).toBeUndefined();
		expect(second.event).toBeUndefined();
		expect(afterCooldown.event?.transition).toBe("start");
	});

	it("requires two normal windows to recover", () => {
		const state: MetricState = {
			...emptyMetricState(),
			phase: "firing",
			samples: [
				{ windowEnd: "1", value: 100 },
				{ windowEnd: "2", value: 100 },
				{ windowEnd: "3", value: 100 },
			],
		};
		const first = evaluateMetric(state, counterSample(100, "4"), config, 0);
		const second = evaluateMetric(first.nextState, counterSample(100, "5"), config, 1);

		expect(first.event).toBeUndefined();
		expect(second.event?.transition).toBe("recovery");
	});

	it("evaluates storage as a gauge", () => {
		const state: MetricState = {
			...emptyMetricState(),
			samples: [
				{ windowEnd: "1", value: 10 * 1024 * 1024 },
				{ windowEnd: "2", value: 10 * 1024 * 1024 },
				{ windowEnd: "3", value: 10 * 1024 * 1024 },
			],
		};

		const evaluation = evaluateMetric(
			state,
			storageSample(13 * 1024 * 1024, "4"),
			config,
			0,
		);
		expect(evaluation.nextState.breachWindows).toBe(1);
	});

	it("ignores a duplicate window", () => {
		const state: MetricState = {
			...emptyMetricState(),
			lastProcessedWindowEnd: "4",
		};
		const evaluation = evaluateMetric(state, counterSample(500, "4"), config, 0);
		expect(evaluation.ignored).toBe(true);
		expect(evaluation.nextState).toBe(state);
	});
});

function counterSample(value: number, windowEnd: string): MetricSample {
	return {
		id: "workers.requests",
		kind: "counter",
		value,
		observedAt: windowEnd,
		windowStart: windowEnd,
		windowEnd,
	};
}

function storageSample(value: number, windowEnd: string): MetricSample {
	return {
		id: "r2.storageBytes",
		kind: "gauge",
		value,
		observedAt: windowEnd,
		windowStart: windowEnd,
		windowEnd,
	};
}
