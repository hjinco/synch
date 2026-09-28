import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CoordinatorSyncAccessService,
	type SyncAccessSnapshot,
} from "./sync-access-service";
import { SocketConnectionService } from "./socket-connection-service";
import { SqliteSyncAccessStore } from "../../adapters/outbound/sqlite/sync-access-store";
import {
	createSqliteCoordinator,
	closeAllTestSqliteCoordinators,
	testSession,
} from "../../adapters/outbound/sqlite/test-helpers";
import { createMockCoordinatorSocketService } from "../../test-helpers";

afterEach(() => {
	vi.useRealTimers();
	closeAllTestSqliteCoordinators();
});

async function setup() {
	const { handle } = await createSqliteCoordinator();
	const store = new SqliteSyncAccessStore(handle);
	let snapshot: SyncAccessSnapshot = {
		suspended: false,
		grants: [{ userId: "member", accessVersion: 1 }],
	};
	const readSnapshot = vi.fn(async () => snapshot);
	const sessions = ["owner", "member"].map((userId) => ({
		connectionId: userId,
		session: testSession({ userId, accessVersion: 1 }),
	}));
	const sockets = createMockCoordinatorSocketService({
		listSocketSessions: () => [...sessions],
		closeSocket: vi.fn((id) => {
			const index = sessions.findIndex((session) => session.connectionId === id);
			if (index >= 0) sessions.splice(index, 1);
		}),
	});
	const create = () => new CoordinatorSyncAccessService(
		store, sockets, readSnapshot, 120_000,
	);
	return {
		store, readSnapshot, sockets, create, service: create(),
		setSnapshot: (value: Partial<SyncAccessSnapshot>) => {
			snapshot = { ...snapshot, ...value };
		},
	};
}
const member = { vaultId: "vault-1", userId: "member", accessVersion: 1 };

describe("coordinator-local sync access", () => {
	it("authorizes messages and reconnects without D1 reads", async () => {
		const { service, readSnapshot } = await setup();
		service.require(member);
		readSnapshot.mockRejectedValue(new Error("D1 is unavailable"));
		for (let i = 0; i < 20; i++) expect(() => service.require(member)).not.toThrow();
		expect(readSnapshot).not.toHaveBeenCalled();
	});

	it("persists the minimum version and only disconnects the revoked user's sockets", async () => {
		const { service, setSnapshot, sockets, create, readSnapshot } = await setup();
		service.require(member);
		setSnapshot({ grants: [{ userId: "member", accessVersion: 2 }] });
		await service.refresh("vault-1");
		expect(sockets.closeSocket).toHaveBeenCalledExactlyOnceWith("member", 1012, "vault access changed; reconnect");
		expect(() => service.require(member)).toThrow("This sync session is no longer authorized");
		expect(() => service.require({ ...member, userId: "owner" })).not.toThrow();

		// A fresh service has no in-memory state, as after DO hibernation/restart.
		const restored = create();
		readSnapshot.mockRejectedValue(new Error("D1 is unavailable"));
		expect(() => restored.require(member)).toThrow("This sync session is no longer authorized");
		expect(() => restored.require({ ...member, accessVersion: 3 })).not.toThrow();
		expect(readSnapshot).toHaveBeenCalledTimes(1);
	});

	it("keeps old versions blocked through regrant and prunes after their token lifetime", async () => {
		const { service, setSnapshot, store, readSnapshot } = await setup();
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		setSnapshot({ grants: [{ userId: "member", accessVersion: 3 }] });
		await service.refresh("vault-1");
		expect(() => service.require(member)).toThrow("This sync session is no longer authorized");
		expect(() => service.require({ ...member, accessVersion: 3 })).not.toThrow();
		vi.setSystemTime(1_119_999);
		service.require({ ...member, accessVersion: 3 });
		expect(store.readRevocations()).toHaveLength(1);
		vi.setSystemTime(1_120_000);
		service.require({ ...member, accessVersion: 3 });
		expect(store.readRevocations()).toEqual([]);
		expect(readSnapshot).toHaveBeenCalledTimes(1);
	});

	it("applies subscription notifications and persists the block until renewal or token expiry", async () => {
		const { service, store, setSnapshot, readSnapshot, sockets, create } = await setup();
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		setSnapshot({ suspended: true });
		// No DO timer or D1 poll: a subscription notification initiates the change.
		service.require(member);
		expect(readSnapshot).not.toHaveBeenCalled();
		await service.refresh("vault-1");
		expect(sockets.closeSocket).toHaveBeenCalledTimes(2);
		expect(service.authorizeVerified(member)).toMatchObject({ code: "sharing_suspended" });
		expect(create().authorizeVerified(member)).toMatchObject({ code: "sharing_suspended" });
		expect(store.readRevocations()).toEqual([
			{ key: "vault", minimumVersion: null, expiresAt: 1_120_000 },
		]);

		// Renewal removes the vault-wide block while retaining revoked members.
		setSnapshot({ suspended: false, grants: [{ userId: "member", accessVersion: 2 }] });
		await service.refresh("vault-1");
		expect(() => service.require({ ...member, userId: "owner" })).not.toThrow();
		expect(() => service.require(member)).toThrow("This sync session is no longer authorized");
		expect(store.readRevocations()).toEqual([
			{ key: "user:member", minimumVersion: 2, expiresAt: 1_120_000 },
		]);
	});

	it("retains successful revocations when a later refresh fails and can retry", async () => {
		const { service, setSnapshot, readSnapshot, create } = await setup();
		setSnapshot({ grants: [{ userId: "member", accessVersion: 2 }] });
		await service.refresh("vault-1");
		readSnapshot.mockRejectedValueOnce(new Error("D1 unavailable"));
		await expect(service.refresh("vault-1")).rejects.toThrow("D1 unavailable");
		expect(() => create().require(member)).toThrow("This sync session is no longer authorized");
		await expect(service.refresh("vault-1")).resolves.toBeUndefined();
	});

	it("rejects a prepared socket if access changes before native acceptance", async () => {
		const { service, setSnapshot } = await setup();
		const connectionService = new SocketConnectionService(
			{
				verifySyncToken: async () => {
					service.require(member);
					return {
						sub: member.userId,
						vaultId: member.vaultId,
						accessVersion: member.accessVersion,
						localVaultId: "local-1",
						displayName: "Member",
						scope: "vault:sync",
						iat: Math.floor(Date.now() / 1000),
						exp: Math.floor(Date.now() / 1000) + 120,
					};
				},
			},
			{
				ensureVaultState: async () => {
					setSnapshot({ grants: [{ userId: "member", accessVersion: 2 }] });
					await service.refresh("vault-1");
				},
			},
			{ scheduleSummaryFlush: async () => {} },
			(session) => service.require({
				vaultId: session.vaultId,
				userId: session.userId,
				accessVersion: session.accessVersion ?? 1,
			}),
		);
		const prepared = await connectionService.prepareSocketSession("token", "vault-1");
		expect(() => connectionService.assertSessionAccess(prepared)).toThrow(
			"This sync session is no longer authorized",
		);

		// A delayed handshake must not slip through after revocation records expire.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 121_000);
		service.require({ ...member, accessVersion: 3 });
		expect(() => connectionService.assertSessionAccess(prepared)).toThrow("invalid_token");
	});

	it("reloads persisted revocations even when a later storage operation fails", async () => {
		const { service, store, setSnapshot } = await setup();
		service.require(member);
		setSnapshot({ grants: [{ userId: "member", accessVersion: 2 }] });
		vi.spyOn(store, "deleteRevocation").mockImplementationOnce(() => {
			throw new Error("storage unavailable");
		});
		await expect(service.refresh("vault-1")).rejects.toThrow("storage unavailable");
		expect(() => service.require(member)).toThrow("This sync session is no longer authorized");
		await expect(service.refresh("vault-1")).resolves.toBeUndefined();
	});
});
