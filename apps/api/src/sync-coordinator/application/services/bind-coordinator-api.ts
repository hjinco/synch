import type { CoordinatorApplicationPort } from "../ports/inbound/coordinator";
import type { SocketSession, VaultStateLimits } from "../dto/types";
import type { SyncPauseState } from "../dto/sync-repair";
import type { BlobService } from "./blob-service";
import type { BlobGcService } from "./blob-gc-service";
import type { EntryService } from "./entry-service";
import type { HealthService } from "./health-service";
import type { MaintenanceService } from "./maintenance-service";
import type { MutationService } from "./mutation-service";
import type { SocketConnectionService } from "./socket-connection-service";
import type { VaultService } from "./vault-service";

export type CoordinatorApi = CoordinatorApplicationPort & {
	prepareSocketSession(
		token: string | null | undefined,
		vaultId: string,
	): Promise<SocketSession>;
	completeSocketOpen(): Promise<void>;
	readSyncPause(vaultId: string): SyncPauseState | null;
	detachLocalVault(session: SocketSession): Promise<void>;
	stageBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
		sizeBytes: number,
	): Promise<void>;
	abortStagedBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
	): Promise<void>;
	deleteBlob(
		token: string | null | undefined,
		vaultId: string,
		blobId: string,
	): Promise<void>;
	applyVaultPolicy(
		vaultId: string,
		limits: VaultStateLimits,
	): Promise<{ applied: boolean }>;
	purgeVault(vaultId: string): Promise<void>;
};

export type CoordinatorApiServices = {
	blobService: BlobService;
	blobGcService: BlobGcService;
	entryService: EntryService;
	healthService: HealthService;
	maintenanceService: MaintenanceService;
	mutationService: MutationService;
	socketConnectionService: SocketConnectionService;
	vaultService: VaultService;
};

export function bindCoordinatorApi(services: CoordinatorApiServices): CoordinatorApi {
	return {
		prepareSocketSession: (token, vaultId) =>
			services.socketConnectionService.prepareSocketSession(token, vaultId),
		completeSocketOpen: () => services.socketConnectionService.completeSocketOpen(),
		readSyncPause: (vaultId) => services.vaultService.readSyncPause(vaultId),
		repairSyncState: (vaultId) => services.vaultService.repairSyncState(vaultId),
		listEntryStates: (session, message) =>
			services.entryService.listEntryStates(session, message),
		detachLocalVault: (session) => services.vaultService.detachLocalVault(session),
		listEntryVersions: (session, message) =>
			services.entryService.listEntryVersions(session, message),
		listDeletedEntries: (session, message) =>
			services.entryService.listDeletedEntries(session, message),
		restoreEntryVersion: (session, message) =>
			services.entryService.restoreEntryVersion(session, message),
		restoreEntryVersions: (session, message) =>
			services.entryService.restoreEntryVersions(session, message),
		purgeDeletedEntries: (session, message) =>
			services.entryService.purgeDeletedEntries(session, message),
		stageBlob: (token, vaultId, blobId, sizeBytes) =>
			services.blobService.stageBlob(token, vaultId, blobId, sizeBytes),
		abortStagedBlob: (token, vaultId, blobId) =>
			services.blobService.abortStagedBlob(token, vaultId, blobId),
		deleteBlob: (token, vaultId, blobId) =>
			services.blobService.deleteBlob(token, vaultId, blobId),
		applyVaultPolicy: (vaultId, limits) =>
			services.vaultService.applyVaultPolicy(vaultId, limits),
		purgeVault: (vaultId) => services.vaultService.purgeVault(vaultId),
		commitMutations: (session, message) =>
			services.mutationService.commitMutations(session, message),
		commitMutation: (session, message) =>
			services.mutationService.commitMutation(session, message),
		runGc: (vaultId, options) => services.blobGcService.runGc(vaultId, options),
		handleAlarm: () => services.maintenanceService.handleAlarm(),
		handleSocketClose: async () => {
			if (!services.vaultService.isPurged()) {
				await services.healthService.scheduleSummaryFlush();
			}
		},
		flushHealthSummary: async (options) => {
			await services.healthService.flushSummary(options);
		},
	};
}
