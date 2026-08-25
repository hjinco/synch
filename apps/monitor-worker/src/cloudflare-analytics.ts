import type {
	MetricId,
	MetricSample,
	MonitorEnv,
	MonitorSnapshot,
} from "./types";

export const MONITOR_QUERY = `
query MonitorMetrics(
  $accountId: string!,
  $targetWorker: string!,
  $targetR2Bucket: string!,
  $targetDoNamespaceId: string!,
  $start: Time!,
  $end: Time!,
  $storageStart: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountId }) {
      workersInvocationsAdaptive(
        # No dimensions are selected, so Cloudflare returns one server-side aggregate row.
        limit: 1
        filter: {
          scriptName: $targetWorker
          datetime_geq: $start
          datetime_leq: $end
        }
      ) {
        sum { requests }
      }
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: {
          bucketName: $targetR2Bucket
          datetime_geq: $start
          datetime_leq: $end
        }
      ) {
        sum { requests }
      }
      r2StorageAdaptiveGroups(
        limit: 100
        orderBy: [datetime_DESC]
        filter: {
          bucketName: $targetR2Bucket
          datetime_geq: $start
          datetime_leq: $end
        }
      ) {
        max { payloadSize }
        dimensions { datetime }
      }
      durableObjectsInvocationsAdaptiveGroups(
        limit: 10000
        filter: {
          scriptName: $targetWorker
          namespaceId: $targetDoNamespaceId
          datetime_geq: $start
          datetime_leq: $end
        }
      ) {
        sum { requests }
      }
      durableObjectsSqlStorageGroups(
        limit: 100
        orderBy: [datetime_DESC]
        filter: {
          namespaceId: $targetDoNamespaceId
          datetime_geq: $storageStart
          datetime_leq: $end
        }
      ) {
        max { storedBytes }
        dimensions { datetime }
      }
    }
  }
}`;

interface GraphQLError {
	message?: string;
	code?: number;
}

interface GraphQLBody {
	data?: {
		viewer?: {
			accounts?: Array<{
				workersInvocationsAdaptive?: AnalyticsRow[];
				r2OperationsAdaptiveGroups?: AnalyticsRow[];
				r2StorageAdaptiveGroups?: StorageRow[];
				durableObjectsInvocationsAdaptiveGroups?: AnalyticsRow[];
				durableObjectsSqlStorageGroups?: StorageRow[];
			}>;
		};
	};
	errors?: GraphQLError[];
}

interface AnalyticsRow {
	sum?: {
		requests?: number | null;
	};
}

interface StorageRow {
	max?: {
		payloadSize?: number | null;
		storedBytes?: number | null;
	};
	dimensions?: {
		datetime?: string | null;
	};
}

export interface AnalyticsWindow {
	start: Date;
	end: Date;
}

export async function readCloudflareMetrics(
	env: Pick<
		MonitorEnv,
		| "CLOUDFLARE_ACCOUNT_ID"
		| "TARGET_WORKER"
		| "TARGET_R2_BUCKET"
		| "TARGET_DO_NAMESPACE_ID"
		| "CF_ANALYTICS_TOKEN"
	>,
	window: AnalyticsWindow,
	fetcher: typeof fetch = fetch,
): Promise<MonitorSnapshot> {
	const response = await fetcher(
		"https://api.cloudflare.com/client/v4/graphql",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				query: MONITOR_QUERY,
				variables: {
					accountId: env.CLOUDFLARE_ACCOUNT_ID,
					targetWorker: env.TARGET_WORKER,
					targetR2Bucket: env.TARGET_R2_BUCKET,
					targetDoNamespaceId: env.TARGET_DO_NAMESPACE_ID,
					start: window.start.toISOString(),
					end: window.end.toISOString(),
					storageStart: new Date(window.end.getTime() - 24 * 60 * 60 * 1000).toISOString(),
				},
			}),
		},
	);

	const body = (await response.json()) as GraphQLBody;
	if (!response.ok) {
		throw new Error(`Cloudflare GraphQL HTTP ${response.status}`);
	}
	if (body.errors && body.errors.length > 0) {
		throw new Error(`Cloudflare GraphQL error: ${formatGraphQLErrors(body.errors)}`);
	}

	const account = body.data?.viewer?.accounts?.[0];
	if (!account) {
		throw new Error("Cloudflare GraphQL returned no matching account");
	}

	const samples: MetricSample[] = [];
	const missing: MetricId[] = [];
	appendCounter(
		samples,
		missing,
		"workers.requests",
		account.workersInvocationsAdaptive,
		window,
	);
	appendCounter(
		samples,
		missing,
		"r2.operations",
		account.r2OperationsAdaptiveGroups,
		window,
	);
	appendGauge(
		samples,
		missing,
		"r2.storageBytes",
		account.r2StorageAdaptiveGroups,
		"payloadSize",
		window,
	);
	appendCounter(
		samples,
		missing,
		"durable_objects.requests",
		account.durableObjectsInvocationsAdaptiveGroups,
		window,
	);
	appendGauge(
		samples,
		missing,
		"durable_objects.storageBytes",
		account.durableObjectsSqlStorageGroups,
		"storedBytes",
		window,
	);

	return { samples, missing };
}

function appendCounter(
	samples: MetricSample[],
	missing: MetricId[],
	id: MetricId,
	rows: AnalyticsRow[] | undefined,
	window: AnalyticsWindow,
): void {
	if (!rows) {
		missing.push(id);
		return;
	}

	const value = rows.reduce(
		(total, row) => total + (row.sum?.requests ?? 0),
		0,
	);
	samples.push({
		id,
		kind: "counter",
		value,
		observedAt: window.end.toISOString(),
		windowStart: window.start.toISOString(),
		windowEnd: window.end.toISOString(),
	});
}

function appendGauge(
	samples: MetricSample[],
	missing: MetricId[],
	id: MetricId,
	rows: StorageRow[] | undefined,
	field: "payloadSize" | "storedBytes",
	window: AnalyticsWindow,
): void {
	const latest = rows
		?.filter((row) => row.dimensions?.datetime && row.max?.[field] != null)
		.sort((left, right) => {
			return Date.parse(right.dimensions!.datetime!) - Date.parse(left.dimensions!.datetime!);
		})[0];
	if (!latest?.dimensions?.datetime || latest.max?.[field] == null) {
		missing.push(id);
		return;
	}

	samples.push({
		id,
		kind: "gauge",
		value: latest.max[field]!,
		observedAt: latest.dimensions.datetime,
		windowStart: window.start.toISOString(),
		windowEnd: latest.dimensions.datetime,
	});
}

function formatGraphQLErrors(errors: GraphQLError[]): string {
	return errors
		.map((error) => `${error.code ?? "unknown"}: ${error.message ?? "unknown error"}`)
		.join("; ");
}
