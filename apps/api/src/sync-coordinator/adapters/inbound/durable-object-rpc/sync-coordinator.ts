import { DurableObject } from "cloudflare:workers";
import { apiError } from "../../../../errors";
import type {
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	DeletedEntriesListedMessage,
	DeletedEntriesPurgeResult,
	EntryStatesListedMessage,
	EntryVersionsListedMessage,
	ListDeletedEntriesMessage,
	ListEntryStatesMessage,
	ListEntryVersionsMessage,
	PurgeDeletedEntriesMessage,
	RestoreEntryVersionMessage,
	RestoreEntryVersionResult,
	RestoreEntryVersionsMessage,
	RestoreEntryVersionsResult,
	SocketSession,
} from "../../../application/dto/types";
import type { CoordinatorApplicationPort } from "../../../application/ports/inbound/coordinator";
import type { CoordinatorSocketMessageHandler } from "../websocket/socket-message-handler";
import type { SyncRepairResult } from "../../../application/dto/sync-repair";
import { SyncCoordinatorApplicationError } from "../../../application/errors/coordinator-errors";
import { createCoordinatorRuntime } from "../../../../runtime";
import {
	formatClientControlMessageError,
	parseClientControlMessage,
} from "../websocket/protocol";

const ALARM_FAILURE_RETRY_MS = 30 * 1000;

export class SyncCoordinator extends DurableObject {
	private readonly app: ReturnType<typeof createCoordinatorRuntime>["app"];
	private readonly useCases: CoordinatorApplicationPort;
	private readonly socketMessageHandler: CoordinatorSocketMessageHandler;
	private readonly socketGateway: ReturnType<typeof createCoordinatorRuntime>["socketGateway"];
	private readonly ready: Promise<void>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const runtime = createCoordinatorRuntime(ctx, env);
		this.app = runtime.app;
		this.useCases = runtime.useCases;
		this.socketMessageHandler = runtime.socketMessageHandler;
		this.socketGateway = runtime.socketGateway;
		this.ready = runtime.ready;
	}

	async fetch(request: Request): Promise<Response> {
		try {
			await this.ready;
			return await this.app.fetch(request);
		} catch (error) {
			this.logError("fetch", error, request);
			return internalErrorResponse();
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		let connectionId: string | null = null;
		try {
			connectionId = this.socketGateway.connectionIdFor(ws);
			await this.ready;
			if (!connectionId) return;
			if (typeof message !== "string") {
				this.socketGateway.sendSocketMessage(connectionId, {
					type: "session_error",
					code: "invalid_message",
					message: "binary websocket messages are not supported",
				});
				return;
			}

			let parsedMessage: unknown;
			try {
				parsedMessage = JSON.parse(message) as unknown;
			} catch {
				this.socketGateway.sendSocketMessage(connectionId, {
					type: "session_error",
					code: "invalid_json",
					message: "websocket message must be valid json",
				});
				return;
			}

			const result = parseClientControlMessage(parsedMessage);
			if (!result.success) {
				this.socketGateway.sendSocketMessage(connectionId, {
					type: "session_error",
					code: "invalid_message",
					message: formatClientControlMessageError(result.error),
				});
				return;
			}
			await this.socketMessageHandler.handle(connectionId, result.data);
		} catch (error) {
			this.logError("webSocketMessage", error);
			if (connectionId) this.sendInternalSocketError(connectionId);
		}
	}

	async commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
	): Promise<CommitMutationsResult> {
		return await this.withRpcError("commitMutations", () =>
			this.useCases.commitMutations(session, message),
		);
	}

	async commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
	): Promise<CommitMutationResult> {
		return await this.withRpcError("commitMutation", () =>
			this.useCases.commitMutation(session, message),
		);
	}

	async listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): Promise<EntryStatesListedMessage> {
		return await this.withRpcError("listEntryStates", async () =>
			this.useCases.listEntryStates(session, message),
		);
	}

	async listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage> {
		return await this.withRpcError("listEntryVersions", () =>
			this.useCases.listEntryVersions(session, message),
		);
	}

	async listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage> {
		return await this.withRpcError("listDeletedEntries", () =>
			this.useCases.listDeletedEntries(session, message),
		);
	}

	async restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult> {
		return await this.withRpcError("restoreEntryVersion", () =>
			this.useCases.restoreEntryVersion(session, message),
		);
	}

	async restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult> {
		return await this.withRpcError("restoreEntryVersions", () =>
			this.useCases.restoreEntryVersions(session, message),
		);
	}

	async purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult> {
		return await this.withRpcError("purgeDeletedEntries", () =>
			this.useCases.purgeDeletedEntries(session, message),
		);
	}

	async runGc(): Promise<void> {
		await this.withRpcError("runGc", () => this.useCases.runGc());
	}

	async repairSyncState(
		vaultId: string,
	): Promise<SyncRepairResult> {
		return await this.withRpcError("repairSyncState", () =>
			this.useCases.repairSyncState(vaultId),
		);
	}

	async flushHealthSummary(): Promise<void> {
		await this.withRpcError("flushHealthSummary", () =>
			this.useCases.flushHealthSummary(),
		);
	}

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		try {
			await this.ready;
			await this.useCases.handleAlarm();
		} catch (error) {
			console.error("[sync-coordinator] durable object alarm failed", {
				objectId: this.ctx.id.toString(),
				alarmInfo,
				error: formatLogError(error),
			});
			try {
				const retryAt = Date.now() + ALARM_FAILURE_RETRY_MS;
				await this.ctx.storage.setAlarm(retryAt);
				console.error("[sync-coordinator] durable object alarm retry scheduled", {
					objectId: this.ctx.id.toString(),
					retryAt,
				});
			} catch (retryError) {
				console.error("[sync-coordinator] durable object alarm retry scheduling failed", {
					objectId: this.ctx.id.toString(),
					error: formatLogError(retryError),
				});
				throw error;
			}
		}
	}

	async webSocketClose(
		ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		await this.handleWebSocketTermination(ws, "webSocketClose");
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.handleWebSocketTermination(ws, "webSocketError");
	}

	private async withRpcError<T>(
		operationName: string,
		operation: () => Promise<T>,
	): Promise<T> {
		try {
			await this.ready;
			return await operation();
		} catch (error) {
			const mappedError = mapCoordinatorRpcError(error);
			if (mappedError === error) {
				this.logError("rpc:" + operationName, error);
			}
			throw mappedError;
		}
	}

	private async handleWebSocketTermination(
		ws: WebSocket,
		operationName: "webSocketClose" | "webSocketError",
	): Promise<void> {
		let connectionId: string | null = null;
		try {
			connectionId = this.socketGateway.connectionIdFor(ws);
		} catch (error) {
			this.logError(operationName + ":connection", error);
		}

		try {
			await this.ready;
		} catch (error) {
			this.logError(operationName + ":ready", error);
			return;
		}

		if (connectionId) {
			try {
				this.socketMessageHandler.handleDisconnect(connectionId);
			} catch (error) {
				this.logError(operationName + ":disconnect", error);
			}
		}

		try {
			await this.useCases.handleSocketClose();
		} catch (error) {
			this.logError(operationName + ":cleanup", error);
		}
	}

	private sendInternalSocketError(connectionId: string): void {
		try {
			this.socketGateway.sendSocketMessage(connectionId, {
				type: "session_error",
				code: "internal_error",
				message: "unexpected server error",
			});
		} catch (error) {
			this.logError("webSocketMessage:error-response", error);
		}
	}

	private logError(source: string, error: unknown, request?: Request): void {
		console.error("[sync-coordinator] " + source + " failed", {
			objectId: this.ctx.id.toString(),
			request: request ? formatRequestForLog(request) : undefined,
			error: formatLogError(error),
		});
	}
}

function internalErrorResponse(): Response {
	return Response.json(
		{
			error: "internal_error",
			message: "unexpected server error",
		},
		{ status: 500 },
	);
}

function formatRequestForLog(request: Request): { method: string; path: string } {
	const url = new URL(request.url);
	return {
		method: request.method,
		path: url.pathname,
	};
}

function mapCoordinatorRpcError(error: unknown): unknown {
	if (!(error instanceof SyncCoordinatorApplicationError)) return error;
	if (error.code === "sync_paused") {
		return apiError(403, "forbidden", "vault sync is temporarily paused for repair");
	}
	return apiError(
		rpcErrorStatus(error.code),
		rpcPublicCode(error.code),
		rpcErrorMessage(error),
	);
}

function rpcErrorMessage(error: SyncCoordinatorApplicationError): string {
	if (typeof error.details.message === "string") return error.details.message;
	switch (error.code) {
		case "not_found":
			return "requested version was not found";
		case "stale_revision":
			return `expected base revision ${String(error.details.expectedBaseRevision)} but received ${String(error.details.receivedBaseRevision)}`;
		default:
			return "request failed";
	}
}

function rpcErrorStatus(code: string): 400 | 403 | 404 | 409 | 413 {
	switch (code) {
		case "bad_request":
			return 400;
		case "forbidden":
			return 403;
		case "not_found":
			return 404;
		case "file_too_large":
		case "quota_exceeded":
			return 413;
		default:
			return 409;
	}
}

function rpcPublicCode(code: string): string {
	switch (code) {
		case "blob_already_live":
		case "blob_size_changed":
			return "conflict";
		default:
			return code;
	}
}

function formatLogError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: error.cause,
		};
	}
	return {
		message: String(error),
	};
}
