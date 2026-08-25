import type { AlertEvent, MetricId, MetricSample, MonitorEnv } from "./types";

interface DiscordField {
	name: string;
	value: string;
	inline?: boolean;
}

interface DiscordPayload {
	username: string;
	allowed_mentions: { parse: string[] };
	embeds: Array<{
		title: string;
		color: number;
		fields: DiscordField[];
		timestamp: string;
	}>;
}

export async function sendDiscordAlert(
	env: Pick<MonitorEnv, "DISCORD_WEBHOOK_URL">,
	events: AlertEvent[],
	samples: MetricSample[],
	fetcher: typeof fetch = fetch,
): Promise<void> {
	if (events.length === 0) return;

	const starts = events.filter((event) => event.transition === "start");
	const fields: DiscordField[] = [
		...events.map((event) => ({
			name: `${metricLabel(event.metric.id)} ${event.transition === "start" ? "급증" : "정상화"}`,
			value: formatEvent(event),
			inline: false,
		})),
		...samples.map((sample) => ({
			name: metricLabel(sample.id),
			value: formatMetric(sample),
			inline: true,
		})),
	];

	const payload: DiscordPayload = {
		username: "Cloudflare Monitor",
		allowed_mentions: { parse: [] },
		embeds: [
			{
				title:
					starts.length > 0
						? "🚨 Cloudflare usage alert"
						: "✅ Cloudflare usage recovered",
				color: starts.length > 0 ? 0xed4245 : 0x57f287,
				fields,
				timestamp: new Date().toISOString(),
			},
		],
	};

	await postDiscord(env.DISCORD_WEBHOOK_URL, payload, fetcher);
}

export async function sendMonitorHealthAlert(
	env: Pick<MonitorEnv, "DISCORD_WEBHOOK_URL">,
	title: string,
	description: string,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	await postDiscord(
		env.DISCORD_WEBHOOK_URL,
		{
			username: "Cloudflare Monitor",
			allowed_mentions: { parse: [] },
			embeds: [
				{
					title,
					color: 0xfaa61a,
					fields: [{ name: "상태", value: description }],
					timestamp: new Date().toISOString(),
				},
			],
		},
		fetcher,
	);
}

async function postDiscord(
	webhookUrl: string,
	payload: DiscordPayload,
	fetcher: typeof fetch,
): Promise<void> {
	const response = await fetcher(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		const retryAfter = response.headers.get("Retry-After");
		throw new Error(
			`Discord webhook failed with HTTP ${response.status}${retryAfter ? `; retry after ${retryAfter}` : ""}`,
		);
	}
}

function formatEvent(event: AlertEvent): string {
	const ratio = event.ratio == null ? "n/a" : `${event.ratio.toFixed(1)}x`;
	return [
		`현재: ${formatValue(event.metric.value, event.metric.id)}`,
		`baseline: ${formatValue(event.baseline, event.metric.id)}`,
		`배수: ${ratio}`,
		`구간 종료: ${event.windowEnd}`,
	].join("\n");
}

function formatMetric(sample: MetricSample): string {
	return `${formatValue(sample.value, sample.id)}\n${sample.observedAt}`;
}

function formatValue(value: number, id: MetricId): string {
	if (id.endsWith("storageBytes")) return formatBytes(value);
	return `${Math.round(value).toLocaleString()} requests`;
}

function formatBytes(value: number): string {
	if (value < 1024) return `${Math.round(value)} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let scaled = value;
	let unit = "B";
	for (const nextUnit of units) {
		scaled /= 1024;
		unit = nextUnit;
		if (scaled < 1024) break;
	}
	return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${unit}`;
}

function metricLabel(id: MetricId): string {
	switch (id) {
		case "workers.requests":
			return "Workers / synch-api-managed";
		case "r2.operations":
			return "R2 / synch-bucket operations";
		case "r2.storageBytes":
			return "R2 / synch-bucket storage";
		case "durable_objects.requests":
			return "Durable Objects / SyncCoordinator";
		case "durable_objects.storageBytes":
			return "Durable Objects / SyncCoordinator storage";
	}
}
