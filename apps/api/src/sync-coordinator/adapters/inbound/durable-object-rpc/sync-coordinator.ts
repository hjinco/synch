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
		await this.ready;
		return await this.app.fetch(request);
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.ready;
		const connectionId = this.socketGateway.connectionIdFor(ws);
		if (!connectionId) return;
		if (typeof message !== "string") {
			this.socketGateway.sendSocketMessage(connectionId, {
				type: "session_error",
				code: "invalid_message",
				message: "binary websocket messages are not supported",
			});
			return;
		}
		try {
			const result = parseClientControlMessage(JSON.parse(message) as unknown);
			if (!result.success) {
				this.socketGateway.sendSocketMessage(connectionId, {
					type: "session_error",
					code: "invalid_message",
					message: formatClientControlMessageError(result.error),
				});
				return;
			}
			await this.socketMessageHandler.handle(connectionId, result.data);
		} catch {
			this.socketGateway.sendSocketMessage(connectionId, {
				type: "session_error",
				code: "invalid_json",
				message: "websocket message must be valid json",
			});
		}
	}

	async commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
	): Promise<CommitMutationsResult> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.commitMutations(session, message));
	}

	async commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
	): Promise<CommitMutationResult> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.commitMutation(session, message));
	}

	async listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): Promise<EntryStatesListedMessage> {
		await this.ready;
		return await this.withRpcError(async () => this.useCases.listEntryStates(session, message));
	}

	async listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.listEntryVersions(session, message));
	}

	async listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.listDeletedEntries(session, message));
	}

	async restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.restoreEntryVersion(session, message));
	}

	async restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.restoreEntryVersions(session, message));
	}

	async purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.purgeDeletedEntries(session, message));
	}

	async runGc(): Promise<void> {
		await this.ready;
		await this.withRpcError(() => this.useCases.runGc());
	}

	async repairSyncState(
		vaultId: string,
	): Promise<SyncRepairResult> {
		await this.ready;
		return await this.withRpcError(() => this.useCases.repairSyncState(vaultId));
	}

	async flushHealthSummary(): Promise<void> {
		await this.ready;
		await this.withRpcError(() => this.useCases.flushHealthSummary());
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
		await this.ready;
		const connectionId = this.socketGateway.connectionIdFor(ws);
		if (connectionId) this.socketMessageHandler.handleDisconnect(connectionId);
		await this.useCases.handleSocketClose();
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.ready;
		const connectionId = this.socketGateway.connectionIdFor(ws);
		if (connectionId) this.socketMessageHandler.handleDisconnect(connectionId);
		await this.useCases.handleSocketClose();
	}

	private async withRpcError<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			throw mapCoordinatorRpcError(error);
		}
	}
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
