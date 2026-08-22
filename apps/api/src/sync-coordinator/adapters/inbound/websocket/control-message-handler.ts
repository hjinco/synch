import type {
	CommitMutationsMessage,
	CommitMutationsResult,
	ClientControlMessage,
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
import type {
	HealthStateStore,
	HealthSummaryScheduler,
	SocketGateway,
	VaultStateStore,
} from "../../../application/ports/outbound";
import type { CoordinatorSocketMessageHandler } from "./socket-message-handler";

export type CoordinatorControlMessageUseCases = {
	detachLocalVault(session: SocketSession): Promise<void>;
	commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
	): Promise<CommitMutationsResult>;
	listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): EntryStatesListedMessage;
	listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage>;
	listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage>;
	restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult>;
	restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult>;
	purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult>;
};

export class CoordinatorControlMessageHandler
	implements CoordinatorSocketMessageHandler
{
	constructor(
		private readonly socketService: Pick<
			SocketGateway,
			| "readSocketSession"
			| "attachSocketSession"
			| "sendSocketMessage"
			| "closeSocket"
			| "broadcastExcept"
		>,
		private readonly vaultStateStore: Pick<
			VaultStateStore,
			"currentCursor" | "recordLocalVaultConnection" | "readVaultLimits"
		>,
		private readonly healthStore: Pick<HealthStateStore, "readStorageStatus">,
		private readonly useCases: CoordinatorControlMessageUseCases,
		private readonly healthSummaryScheduler: HealthSummaryScheduler,
	) {}

	async handle(connectionId: string, parsed: ClientControlMessage): Promise<void> {
		const session = this.socketService.readSocketSession(connectionId);
		if (!session) {
			this.socketService.sendSocketMessage(connectionId, {
				type: "session_error",
				code: "unauthorized",
				message: "socket session is missing",
			});
			this.socketService.closeSocket(connectionId, 4401, "missing socket session");
			return;
		}

		if (parsed.type === "hello") {
			try {
				const currentCursor = this.vaultStateStore.currentCursor();
				if (parsed.lastKnownCursor > currentCursor) {
					this.socketService.sendSocketMessage(connectionId, {
						type: "session_error",
						code: "cursor_ahead_of_server",
						message:
							"Sync was paused because this device's sync history no longer matches the remote vault. To resume syncing, disconnect and reconnect the remote vault in Synch settings.",
					});
					return;
				}
				this.vaultStateStore.recordLocalVaultConnection(
					session.userId,
					session.localVaultId,
				);
				const limits = this.vaultStateStore.readVaultLimits();
				await this.healthSummaryScheduler.scheduleSummaryFlush();
				this.socketService.sendSocketMessage(connectionId, {
					type: "hello_ack",
					requestId: parsed.requestId,
					cursor: this.vaultStateStore.currentCursor(),
					policy: {
						storageLimitBytes: limits.storageLimitBytes,
						maxFileSizeBytes: limits.maxFileSizeBytes,
					},
					storageStatus: this.healthStore.readStorageStatus(),
				});
			} catch (error) {
				this.socketService.sendSocketMessage(connectionId, {
					type: "session_error",
					code: "hello_failed",
					message: error instanceof Error ? error.message : "hello failed",
				});
			}
			return;
		}

		if (parsed.type === "commit_mutations") {
			let result: CommitMutationsResult;
			try {
				result = await this.useCases.commitMutations(session, parsed);
			} catch (error) {
				this.socketService.sendSocketMessage(connectionId, {
					type: "commit_mutations_failed",
					requestId: parsed.requestId,
					code: "commit_failed",
					message: error instanceof Error ? error.message : "commit failed",
				});
				return;
			}

			this.socketService.sendSocketMessage(connectionId, result.message);
			if (result.broadcastCursor !== null) {
				this.broadcastCursorExcept(connectionId, result.broadcastCursor);
			}
			return;
		}

		if (parsed.type === "list_entry_states") {
			try {
					this.socketService.sendSocketMessage(
						connectionId,
					this.useCases.listEntryStates(session, parsed),
				);
			} catch (error) {
				const details = websocketRequestError(
					error,
					"entry_states_list_failed",
					"entry states list failed",
				);
				this.socketService.sendSocketMessage(connectionId, {
					type: "entry_states_list_failed",
					requestId: parsed.requestId,
					code: details.code,
					message: details.message,
				});
			}
			return;
		}

		if (parsed.type === "list_entry_versions") {
			try {
					this.socketService.sendSocketMessage(
						connectionId,
					await this.useCases.listEntryVersions(session, parsed),
				);
			} catch (error) {
				const details = websocketRequestError(
					error,
					"entry_versions_list_failed",
					"entry history failed",
				);
				this.socketService.sendSocketMessage(connectionId, {
					type: "entry_versions_list_failed",
					requestId: parsed.requestId,
					code: details.code,
					message: details.message,
				});
			}
			return;
		}

		if (parsed.type === "list_deleted_entries") {
			try {
					this.socketService.sendSocketMessage(
						connectionId,
					await this.useCases.listDeletedEntries(session, parsed),
				);
			} catch (error) {
				const details = websocketRequestError(
					error,
					"deleted_entries_list_failed",
					"deleted entries list failed",
				);
				this.socketService.sendSocketMessage(connectionId, {
					type: "deleted_entries_list_failed",
					requestId: parsed.requestId,
					code: details.code,
					message: details.message,
				});
			}
			return;
		}

		if (parsed.type === "restore_entry_version") {
			let result: RestoreEntryVersionResult;
			try {
				result = await this.useCases.restoreEntryVersion(session, parsed);
			} catch (error) {
				const details = websocketRequestError(
					error,
					"entry_restore_failed",
					"entry restore failed",
				);
				this.socketService.sendSocketMessage(connectionId, {
					type: "entry_restore_failed",
					requestId: parsed.requestId,
					code: details.code,
					message: details.message,
				});
				return;
			}

				this.socketService.sendSocketMessage(connectionId, result.message);
			if (result.broadcastCursor !== null) {
				this.broadcastCursorExcept(connectionId, result.broadcastCursor);
			}
			return;
		}

		if (parsed.type === "restore_entry_versions") {
			let result: RestoreEntryVersionsResult;
			try {
				result = await this.useCases.restoreEntryVersions(session, parsed);
			} catch (error) {
				const details = websocketRequestError(
					error,
					"entry_restore_failed",
					"entry restore failed",
				);
				this.socketService.sendSocketMessage(connectionId, {
					type: "entry_restore_failed",
					requestId: parsed.requestId,
					code: details.code,
					message: details.message,
				});
				return;
			}

			this.socketService.sendSocketMessage(connectionId, result.message);
			if (result.broadcastCursor !== null) {
				this.broadcastCursorExcept(connectionId, result.broadcastCursor);
			}
			return;
		}

		if (parsed.type === "purge_deleted_entries") {
			try {
				const result = await this.useCases.purgeDeletedEntries(session, parsed);
				this.socketService.sendSocketMessage(connectionId, result.message);
			} catch (error) {
				const details = websocketRequestError(
					error,
					"deleted_entries_purge_failed",
					"deleted entries purge failed",
				);
				this.socketService.sendSocketMessage(connectionId, {
					type: "deleted_entries_purge_failed",
					requestId: parsed.requestId,
					code: details.code,
					message: details.message,
				});
			}
			return;
		}

		if (parsed.type === "detach_local_vault") {
			try {
				await this.useCases.detachLocalVault(session);
				this.socketService.sendSocketMessage(connectionId, {
					type: "local_vault_detached",
					requestId: parsed.requestId,
				});
			} catch (error) {
				this.socketService.sendSocketMessage(connectionId, {
					type: "session_error",
					code: "detach_failed",
					message: error instanceof Error ? error.message : "detach failed",
				});
			}
			return;
		}

		if (parsed.type === "heartbeat") {
			this.socketService.sendSocketMessage(connectionId, {
				type: "heartbeat_ack",
				requestId: parsed.requestId,
			});
			return;
		}

		if (parsed.type === "watch_storage_status") {
			const nextSession = {
				...session,
				wantsStorageStatus: true,
			};
			this.socketService.attachSocketSession(connectionId, nextSession);
			this.socketService.sendSocketMessage(connectionId, {
				type: "storage_status_updated",
				storageStatus: this.healthStore.readStorageStatus(),
			});
			return;
		}

		if (parsed.type === "unwatch_storage_status") {
			this.socketService.attachSocketSession(connectionId, {
				...session,
				wantsStorageStatus: false,
			});
			return;
		}

		this.socketService.sendSocketMessage(connectionId, {
			type: "session_error",
			code: "unsupported_message",
			message: "unsupported websocket message type",
		});
	}

	private broadcastCursorExcept(connectionId: string, cursor: number): void {
		try {
			this.socketService.broadcastExcept(connectionId, {
				type: "cursor_advanced",
				cursor,
			});
		} catch (error) {
			console.error("[sync-coordinator] cursor broadcast failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function websocketRequestError(
	error: unknown,
	fallbackCode: string,
	fallbackMessage: string,
): { code: string; message: string } {
	const code = extractErrorCode(error) ?? fallbackCode;
	const message =
		error instanceof Error && error.message.trim()
			? error.message
			: fallbackMessage;
	return { code, message };
}

function extractErrorCode(error: unknown): string | null {
	if (!error || typeof error !== "object") {
		return null;
	}

	if ("code" in error && typeof error.code === "string" && error.code.trim()) {
		return error.code;
	}

	if ("cause" in error) {
		const cause = error.cause;
		if (
			cause &&
			typeof cause === "object" &&
			"code" in cause &&
			typeof cause.code === "string" &&
			cause.code.trim()
		) {
			return cause.code;
		}
	}

	return null;
}
