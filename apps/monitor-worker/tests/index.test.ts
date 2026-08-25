import { describe, expect, it } from "vitest";

import { runMonitorCycle } from "../src/index";
import { readMonitorState } from "../src/state";
import type {
	AlertEvent,
	MetricSample,
	MonitorEnv,
	MonitorSnapshot,
} from "../src/types";

class FakeKV {
	private value: string | undefined;

	async get<T>(_key: string, _type: "json"): Promise<T | null> {
		return this.value ? (JSON.parse(this.value) as T) : null;
	}

	async put(_key: string, value: string): Promise<void> {
		this.value = value;
	}
}

describe("monitor cycle", () => {
	it("sends start and recovery events without repeating firing alerts", async () => {
		const kv = new FakeKV();
		const env = {
			CLOUDFLARE_ACCOUNT_ID: "account",
			TARGET_WORKER: "synch-api-managed",
			TARGET_R2_BUCKET: "synch-bucket",
			TARGET_DO_NAMESPACE_ID: "namespace",
			ALERT_CONFIG: JSON.stringify({
				warmupSamples: 3,
				maxSamples: 3,
				requiredBreachWindows: 2,
				requiredRecoveryWindows: 2,
			}),
			CF_ANALYTICS_TOKEN: "token",
			DISCORD_WEBHOOK_URL: "https://discord.test/webhook",
			MONITOR_STATE: kv,
		} as unknown as MonitorEnv;
		const values = [100, 100, 100, 400, 500, 100, 100];
		const alerts: AlertEvent[][] = [];
		let run = 0;

		for (const value of values) {
			const scheduledTime = (run + 1) * 5 * 60 * 1000;
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
			run += 1;
		}

		expect(alerts).toHaveLength(2);
		expect(alerts[0]?.[0]?.transition).toBe("start");
		expect(alerts[1]?.[0]?.transition).toBe("recovery");

		const state = await readMonitorState({
			MONITOR_STATE: kv as unknown as KVNamespace,
		});
		expect(state.metrics["workers.requests"].phase).toBe("normal");
	});

	it("keeps a transition pending when Discord delivery fails", async () => {
		const kv = new FakeKV();
		const env = createEnv(kv, 3);
		const values = [100, 100, 100, 400, 500, 2000];
		let run = 0;
		let attempts = 0;
		const alerts: AlertEvent[][] = [];

		for (const value of values) {
			const scheduledTime = (run + 1) * 5 * 60 * 1000;
			await runMonitorCycle(env, scheduledTime, {
				readMetrics: async () => ({
					samples: [sample(value, scheduledTime)],
					missing: [],
				}),
				sendAlert: async (_env, events) => {
					attempts += 1;
					if (attempts === 1) throw new Error("discord unavailable");
					alerts.push(events);
				},
				sendHealthAlert: async () => undefined,
			});
			run += 1;
		}

		const state = await readMonitorState({
			MONITOR_STATE: kv as unknown as KVNamespace,
		});
		expect(attempts).toBe(2);
		expect(alerts[0]?.[0]?.transition).toBe("start");
		expect(state.metrics["workers.requests"].phase).toBe("firing");
	});

	it("notifies once after three monitor failures and on recovery", async () => {
		const kv = new FakeKV();
		const env = createEnv(kv, 3);
		const healthAlerts: string[] = [];

		for (let run = 0; run < 3; run += 1) {
			await runMonitorCycle(env, (run + 1) * 5 * 60 * 1000, {
				readMetrics: async () => {
					throw new Error("analytics unavailable");
				},
				sendAlert: async () => undefined,
				sendHealthAlert: async (_env, title) => {
					healthAlerts.push(title);
				},
			});
		}

		await runMonitorCycle(env, 4 * 5 * 60 * 1000, {
			readMetrics: async () => ({ samples: [], missing: [] }),
			sendAlert: async () => undefined,
			sendHealthAlert: async (_env, title) => {
				healthAlerts.push(title);
			},
		});

		expect(healthAlerts).toEqual([
			"⚠️ Cloudflare monitor degraded",
			"✅ Cloudflare monitor recovered",
		]);
	});
});

function createEnv(kv: FakeKV, warmupSamples: number): MonitorEnv {
	return {
		CLOUDFLARE_ACCOUNT_ID: "account",
		TARGET_WORKER: "synch-api-managed",
		TARGET_R2_BUCKET: "synch-bucket",
		TARGET_DO_NAMESPACE_ID: "namespace",
		ALERT_CONFIG: JSON.stringify({
			warmupSamples,
			maxSamples: warmupSamples,
			requiredBreachWindows: 2,
			requiredRecoveryWindows: 2,
		}),
		CF_ANALYTICS_TOKEN: "token",
		DISCORD_WEBHOOK_URL: "https://discord.test/webhook",
		MONITOR_STATE: kv as unknown as KVNamespace,
	};
}

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
