import { describe, expect, it, vi } from "vitest";

import { sendDiscordAlert } from "../src/discord";
import type { AlertEvent, MetricSample } from "../src/types";

describe("Discord notifications", () => {
	it("sends one combined embed with mentions disabled", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, { status: 204 }),
		);
		const metric: MetricSample = {
			id: "workers.requests",
			kind: "counter",
			value: 1200,
			observedAt: "2026-08-25T00:05:00Z",
			windowStart: "2026-08-25T00:00:00Z",
			windowEnd: "2026-08-25T00:05:00Z",
		};
		const event: AlertEvent = {
			transition: "start",
			metric,
			baseline: 300,
			ratio: 4,
			windowEnd: metric.windowEnd,
		};

		await sendDiscordAlert(
			{ DISCORD_WEBHOOK_URL: "https://discord.test/webhook" },
			[event],
			[metric],
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledTimes(1);
		const request = fetcher.mock.calls[0]?.[1];
		const payload = JSON.parse(String(request?.body));
		expect(payload.allowed_mentions).toEqual({ parse: [] });
		expect(payload.embeds).toHaveLength(1);
		expect(payload.embeds[0].color).toBe(0xed4245);
		expect(payload.embeds[0].fields.length).toBeGreaterThan(0);
	});
});
