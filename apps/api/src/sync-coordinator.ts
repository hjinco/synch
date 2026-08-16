import { DurableObject } from "cloudflare:workers";
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
} from "./sync/coordinator/types";
import type { CoordinatorDurableObjectUseCases } from "./sync/coordinator/service";
import type { CoordinatorSocketMessageHandler } from "./sync/coordinator/socket/control-message-handler";
import { createCoordinatorRuntime } from "./runtime";

const ALARM_FAILURE_RETRY_MS = 30 * 1000;

export class SyncCoordinator extends DurableObject {
	private readonly app: ReturnType<typeof createCoordinatorRuntime>["app"];
	private readonly useCases: CoordinatorDurableObjectUseCases;
	private readonly socketMessageHandler: CoordinatorSocketMessageHandler;
	private readonly ready: Promise<void>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const runtime = createCoordinatorRuntime(ctx, env);
		this.app = runtime.app;
		this.useCases = runtime.useCases;
		this.socketMessageHandler = runtime.socketMessageHandler;
		this.ready = runtime.ready;
	}

	async fetch(request: Request): Promise<Response> {
		await this.ready;
		return await this.app.fetch(request);
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.ready;
		await this.socketMessageHandler.handle(ws, message);
	}

	async commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
	): Promise<CommitMutationsResult> {
		await this.ready;
		return await this.useCases.commitMutations(session, message);
	}

	async commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
	): Promise<CommitMutationResult> {
		await this.ready;
		return await this.useCases.commitMutation(session, message);
	}

	async listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): Promise<EntryStatesListedMessage> {
		await this.ready;
		return this.useCases.listEntryStates(session, message);
	}

	async listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage> {
		await this.ready;
		return await this.useCases.listEntryVersions(session, message);
	}

	async listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage> {
		await this.ready;
		return await this.useCases.listDeletedEntries(session, message);
	}

	async restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult> {
		await this.ready;
		return await this.useCases.restoreEntryVersion(session, message);
	}

	async restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult> {
		await this.ready;
		return await this.useCases.restoreEntryVersions(session, message);
	}

	async purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult> {
		await this.ready;
		return await this.useCases.purgeDeletedEntries(session, message);
	}

	async runGc(): Promise<void> {
		await this.ready;
		await this.useCases.runGc();
	}

	async flushHealthSummary(): Promise<void> {
		await this.ready;
		await this.useCases.flushHealthSummary();
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
		_ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		await this.ready;
		await this.useCases.handleSocketClose();
	}

	async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
		await this.ready;
		await this.useCases.handleSocketClose();
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
