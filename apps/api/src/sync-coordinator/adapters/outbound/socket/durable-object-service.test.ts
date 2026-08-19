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
});

function testSession(overrides: Partial<SocketSession> = {}): SocketSession {
	return {
		userId: "user-1",
		localVaultId: "local-vault-1",
		vaultId: "vault-1",
		wantsStorageStatus: false,
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
