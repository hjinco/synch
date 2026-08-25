import { env as workerEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { readMonitorState } from "../src/state";
import { runMonitorCycle } from "../src/index";
import type {
	AlertEvent,
	MetricSample,
	MonitorEnv,
} from "../src/types";

describe("Cloudflare Worker runtime", () => {
	it("uses the configured KV binding for monitor state", async () => {
		const env = {
			...(workerEnv as unknown as MonitorEnv),
			ALERT_CONFIG: JSON.stringify({
				warmupSamples: 3,
				maxSamples: 3,
				requiredBreachWindows: 2,
				requiredRecoveryWindows: 2,
			}),
		} as MonitorEnv;
		const alerts: AlertEvent[][] = [];
		const values = [100, 100, 100, 400, 2000];

		for (const [index, value] of values.entries()) {
			const scheduledTime = (index + 1) * 5 * 60 * 1000;
			await runMonitorCycle(env, scheduledTime, {
				readMetrics: async () => ({
					samples: [sample(value, scheduledTime)],
					missing: [],
				}),
				sendAlert: async (_env, events) => {
					alerts.push(events);
				},
				sendHealthAlert: async () => undefined,
			});
		}

		const state = await readMonitorState(env);
		expect(state.metrics["workers.requests"].samples).toHaveLength(3);
		expect(state.metrics["workers.requests"].phase).toBe("firing");
		expect(alerts[0]?.[0]?.transition).toBe("start");
	});
});

function sample(value: number, scheduledTime: number): MetricSample {
	const end = new Date(scheduledTime - 5 * 60 * 1000).toISOString();
	const start = new Date(scheduledTime - 10 * 60 * 1000).toISOString();
	return {
		id: "workers.requests",
		kind: "counter",
		value,
		observedAt: end,
		windowStart: start,
		windowEnd: end,
	};
}
