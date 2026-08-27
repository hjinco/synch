import { describe, expect, it, vi } from "vitest";

import { CoordinatorSocketService } from "./durable-object-service";
import type { SocketSession } from "../../../application/dto/types";

const OPEN = 1;
const CLOSED = 3;

describe("CoordinatorSocketService", () => {
	it("closes superseded sockets even when their final message races with close", () => {
		const current = testSocket(testSession({ localVaultId: "local-vault-1" }));
		const superseded = testSocket(testSession({ localVaultId: "local-vault-1" }));
		superseded.send.mockImplementation(() => {
			throw new TypeError("Can't call WebSocket send() after close().");
		});
		const service = new CoordinatorSocketService(
			testDurableObjectState([current, superseded]),
		);

		expect(() =>
			service.closeSupersededSockets(current, testSession()),
		).not.toThrow();

		expect(superseded.send).toHaveBeenCalledTimes(1);
		expect(superseded.close).toHaveBeenCalledWith(
			4409,
			"superseded by newer connection",
		);
	});

	it("treats sockets already closed by the platform as already superseded", () => {
		const current = testSocket(testSession({ localVaultId: "local-vault-1" }));
		const superseded = testSocket(testSession({ localVaultId: "local-vault-1" }), {
			readyState: CLOSED,
		});
		const service = new CoordinatorSocketService(
			testDurableObjectState([current, superseded]),
		);

		expect(() =>
			service.closeSupersededSockets(current, testSession()),
		).not.toThrow();

		expect(superseded.send).not.toHaveBeenCalled();
		expect(superseded.close).not.toHaveBeenCalled();
	});

	it("sends presence messages only to watchers on the same entry", () => {
		const watcher = testSocket(
			testSession({
				wantsPresence: true,
				presenceWatchEntryIds: ["entry-1", "entry-2"],
			}),
		);
		const ignored = testSocket(
			testSession({ wantsPresence: true, presenceWatchEntryIds: ["entry-3"] }),
		);
		const sender = testSocket(testSession({ presenceEntryId: "entry-1" }));
		const service = new CoordinatorSocketService(
			testDurableObjectState([watcher, ignored, sender]),
		);

		service.broadcastPresenceToWatchers("entry-2", service.connectionIdFor(sender), {
			type: "presence_cleared",
			presenceId: service.connectionIdFor(sender),
		});

		expect(watcher.send).toHaveBeenCalledTimes(1);
		expect(ignored.send).not.toHaveBeenCalled();
		expect(sender.send).not.toHaveBeenCalled();
	});

	it("broadcasts presence availability to all presence watchers", () => {
		const watcher = testSocket(testSession({ wantsPresence: true }));
		const secondWatcher = testSocket(testSession({ wantsPresence: true }));
		const ignored = testSocket(testSession());
		const service = new CoordinatorSocketService(
			testDurableObjectState([watcher, secondWatcher, ignored]),
		);

		expect(service.broadcastPresenceAvailability()).toBe(true);
		const message = JSON.stringify({
			type: "presence_availability",
			enabled: true,
		});
		expect(watcher.send).toHaveBeenCalledWith(message);
		expect(secondWatcher.send).toHaveBeenCalledWith(message);
		expect(ignored.send).not.toHaveBeenCalled();
	});

	it("defaults displayName when reading an older socket attachment", () => {
		const socket = {
			readyState: OPEN,
			send: vi.fn(),
			close: vi.fn(),
			deserializeAttachment: vi.fn(() => ({
				connectionId: "conn-1",
				userId: "user-1",
				localVaultId: "local-vault-1",
				vaultId: "vault-1",
			})),
		} as unknown as WebSocket;
		const service = new CoordinatorSocketService(testDurableObjectState([socket]));

		expect(service.readSocketSession("conn-1")).toEqual({
			userId: "user-1",
			localVaultId: "local-vault-1",
			vaultId: "vault-1",
			displayName: "",
			wantsStorageStatus: false,
			wantsPresence: false,
			presenceEntryId: null,
			presenceWatchEntryIds: [],
		});
	});
});

function testSession(overrides: Partial<SocketSession> = {}): SocketSession {
	return {
		userId: "user-1",
		localVaultId: "local-vault-1",
		vaultId: "vault-1",
		displayName: "User",
		wantsStorageStatus: false,
		wantsPresence: false,
		presenceEntryId: null,
		presenceWatchEntryIds: [],
		...overrides,
	};
}

function testDurableObjectState(sockets: WebSocket[]): DurableObjectState {
	return {
		getWebSockets: vi.fn(() => sockets),
	} as unknown as DurableObjectState;
}

function testSocket(
	session: SocketSession,
	{ readyState = OPEN }: { readyState?: number } = {},
): WebSocket & {
	send: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
} {
	return {
		readyState,
		send: vi.fn(),
		close: vi.fn(),
		deserializeAttachment: vi.fn(() => session),
	} as unknown as WebSocket & {
		send: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
}
