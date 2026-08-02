import type { Server } from "node:http";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_FORCE_SETTLE_MS = 1_000;

export interface NodeWebSocketShutdown {
	close(code: number, reason: string): Promise<void>;
	terminate(): void;
}

export interface NodeShutdownResult {
	forced: boolean;
	error?: unknown;
}

/**
 * Stops accepting work, waits for active HTTP/WebSocket work to drain, and
 * only then releases runtime storage. A bounded force-close keeps shutdown
 * from hanging forever on an unresponsive client.
 */
export async function shutdownNodeServer(input: {
	server: Server;
	webSockets: NodeWebSocketShutdown;
	dispose: () => void;
	timeoutMs?: number;
	forceSettleMs?: number;
}): Promise<NodeShutdownResult> {
	const closing = Promise.all([
		closeHttpServer(input.server),
		input.webSockets.close(1012, "server restarting"),
	]).then(
		() => ({ status: "closed" as const }),
		(error: unknown) => ({ status: "failed" as const, error }),
	);

	const result = await withTimeout(
		closing,
		input.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
		{ status: "timed_out" as const },
	);

	if (result.status === "closed") {
		input.dispose();
		return { forced: false };
	}

	input.server.closeAllConnections();
	input.webSockets.terminate();
	await withTimeout(closing, input.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS, undefined);
	input.dispose();

	return {
		forced: true,
		...(result.status === "failed" ? { error: result.error } : {}),
	};
}

function closeHttpServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function withTimeout<T, U>(task: Promise<T>, timeoutMs: number, timeoutValue: U): Promise<T | U> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<U>((resolve) => {
				timeout = setTimeout(() => resolve(timeoutValue), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}
