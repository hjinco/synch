import { describe, expect, it, vi } from "vitest";

import {
	MONITOR_QUERY,
	readCloudflareMetrics,
} from "../src/cloudflare-analytics";

const env = {
	CLOUDFLARE_ACCOUNT_ID: "account",
	TARGET_WORKER: "synch-api-managed",
	TARGET_R2_BUCKET: "synch-bucket",
	TARGET_DO_NAMESPACE_ID: "namespace-id",
	CF_ANALYTICS_TOKEN: "token",
};

describe("Cloudflare analytics client", () => {
	it("aggregates counters and selects the newest storage samples", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [
										{ sum: { requests: 5 } },
										{ sum: { requests: 7 } },
									],
									r2OperationsAdaptiveGroups: [
										{ sum: { requests: 10 } },
										{ sum: { requests: 2 } },
									],
									r2StorageAdaptiveGroups: [
										{
											max: { payloadSize: 2048 },
											dimensions: { datetime: "2026-08-25T00:05:00Z" },
										},
										{
											max: { payloadSize: 1024 },
											dimensions: { datetime: "2026-08-25T00:00:00Z" },
										},
									],
									durableObjectsInvocationsAdaptiveGroups: [
										{ sum: { requests: 3 } },
										{ sum: { requests: 4 } },
									],
									durableObjectsSqlStorageGroups: [
										{
											max: { storedBytes: 4096 },
											dimensions: { datetime: "2026-08-25T00:05:00Z" },
										},
									],
								},
							],
						},
					},
					errors: null,
				}),
				{ status: 200 },
			),
		);

		const snapshot = await readCloudflareMetrics(
			env,
			{
				start: new Date("2026-08-25T00:00:00Z"),
				end: new Date("2026-08-25T00:05:00Z"),
			},
			fetcher,
		);

		expect(snapshot.missing).toEqual([]);
		expect(snapshot.samples).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "workers.requests", value: 12 }),
				expect.objectContaining({ id: "r2.operations", value: 12 }),
				expect.objectContaining({ id: "r2.storageBytes", value: 2048 }),
				expect.objectContaining({ id: "durable_objects.requests", value: 7 }),
				expect.objectContaining({ id: "durable_objects.storageBytes", value: 4096 }),
			]),
		);

		const request = fetcher.mock.calls[0]?.[1];
		expect(request?.method).toBe("POST");
		expect(request?.headers).toMatchObject({
			Authorization: "Bearer token",
		});
		const body = JSON.parse(String(request?.body));
		expect(body.variables).toMatchObject({
			targetWorker: "synch-api-managed",
			targetR2Bucket: "synch-bucket",
			targetDoNamespaceId: "namespace-id",
		});
		expect(body.query).toContain("workersInvocationsAdaptive(\n        # No dimensions are selected, so Cloudflare returns one server-side aggregate row.\n        limit: 1");
	});

	it("keeps missing datasets out of samples", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						viewer: { accounts: [{}] },
					},
					errors: null,
				}),
				{ status: 200 },
			),
		);

		const snapshot = await readCloudflareMetrics(
			env,
			{ start: new Date(0), end: new Date(1) },
			fetcher,
		);

		expect(snapshot.samples).toEqual([]);
		expect(snapshot.missing).toHaveLength(5);
	});

	it("treats empty counter datasets as zero requests", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [
								{
									workersInvocationsAdaptive: [],
									r2OperationsAdaptiveGroups: [],
									r2StorageAdaptiveGroups: [],
									durableObjectsInvocationsAdaptiveGroups: [],
									durableObjectsSqlStorageGroups: [],
								},
							],
						},
					},
					errors: null,
				}),
				{ status: 200 },
			),
		);

		const snapshot = await readCloudflareMetrics(
			env,
			{ start: new Date(0), end: new Date(1) },
			fetcher,
		);

		expect(snapshot.samples).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "workers.requests", value: 0 }),
				expect.objectContaining({ id: "r2.operations", value: 0 }),
				expect.objectContaining({ id: "durable_objects.requests", value: 0 }),
			]),
		);
		expect(snapshot.missing).toEqual([
			"r2.storageBytes",
			"durable_objects.storageBytes",
		]);
	});

	it("rejects GraphQL errors even when HTTP status is 200", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({ errors: [{ code: 1001, message: "bad query" }] }),
				{ status: 200 },
			),
		);

		await expect(
			readCloudflareMetrics(env, { start: new Date(0), end: new Date(1) }, fetcher),
		).rejects.toThrow("bad query");
	});

	it("uses the five-minute window for R2 requests and namespace-only DO requests", () => {
		const r2Start = MONITOR_QUERY.indexOf("r2OperationsAdaptiveGroups");
		const r2End = MONITOR_QUERY.indexOf("r2StorageAdaptiveGroups", r2Start);
		const r2Query = MONITOR_QUERY.slice(r2Start, r2End);

		expect(r2Query).toContain("datetime_geq: $start");
		expect(r2Query).not.toContain("$storageStart");
		expect(MONITOR_QUERY).not.toContain("name: $targetDoClass");
	});

	it("does not query CPU, duration, or periodic Durable Object metrics", () => {
		expect(MONITOR_QUERY).not.toContain("durableObjectsPeriodicGroups");
		expect(MONITOR_QUERY).not.toContain("cpuTime");
		expect(MONITOR_QUERY).not.toContain("duration");
	});
});
