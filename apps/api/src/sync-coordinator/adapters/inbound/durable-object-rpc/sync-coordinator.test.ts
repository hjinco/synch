import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
	createCoordinatorRuntime: vi.fn(),
}));

vi.mock(
	"cloudflare:workers",
	() => ({
		DurableObject: class {
			protected ctx: DurableObjectState;

			constructor(ctx: DurableObjectState) {
				this.ctx = ctx;
			}
		},
	}),
);

vi.mock("../../../../runtime", () => runtimeMocks);

import { SyncCoordinatorApplicationError } from "../../../application/errors/coordinator-errors";
import type {
	CommitMutationMessage,
	SocketSession,
} from "../../../application/dto/types";
import { SyncCoordinator } from "./sync-coordinator";

describe("SyncCoordinator error boundaries", () => {
	let runtime: ReturnType<typeof createRuntime>;
	let coordinator: SyncCoordinator;
	let consoleError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		runtime = createRuntime();
		runtimeMocks.createCoordinatorRuntime.mockReturnValue(runtime);
		coordinator = new SyncCoordinator(
			testDurableObjectState(),
			{} as Env,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it("returns a generic 500 response when coordinator readiness fails", async () => {
		const error = new Error("storage migration failed");
		runtime.ready = Promise.reject(error);
		runtimeMocks.createCoordinatorRuntime.mockReturnValue(runtime);
		coordinator = new SyncCoordinator(testDurableObjectState(), {} as Env);

		const response = await coordinator.fetch(
			new Request("https://internal/internal/v1/vaults/vault-1/sync-state"),
		);

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: "internal_error",
			message: "unexpected server error",
		});
		expect(runtime.app.fetch).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalled();
	});

	it("catches readiness failures in RPC methods and rethrows the original error", async () => {
		const error = new Error("storage migration failed");
		runtime.ready = Promise.reject(error);
		runtimeMocks.createCoordinatorRuntime.mockReturnValue(runtime);
		coordinator = new SyncCoordinator(testDurableObjectState(), {} as Env);

		await expect(
			coordinator.commitMutation(
				{} as SocketSession,
				{} as CommitMutationMessage,
			),
		).rejects.toBe(error);

		expect(runtime.useCases.commitMutation).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalled();
	});

	it("keeps application RPC error mapping while logging and rethrowing unknown errors", async () => {
		const applicationError = new SyncCoordinatorApplicationError("not_found");
		runtime.useCases.commitMutation.mockRejectedValueOnce(applicationError);

		await expect(
			coordinator.commitMutation(
				{} as SocketSession,
				{} as CommitMutationMessage,
			),
		).rejects.toMatchObject({ status: 404 });
		expect(consoleError).not.toHaveBeenCalled();

		const internalError = new Error("sqlite unavailable");
		runtime.useCases.commitMutation.mockRejectedValueOnce(internalError);

		await expect(
			coordinator.commitMutation(
				{} as SocketSession,
				{} as CommitMutationMessage,
			),
		).rejects.toBe(internalError);
		expect(consoleError).toHaveBeenCalled();
	});

	it("reports websocket handler failures as internal session errors", async () => {
		runtime.socketMessageHandler.handle.mockRejectedValueOnce(
			new Error("unexpected handler failure"),
		);

		await coordinator.webSocketMessage(
			{} as WebSocket,
			JSON.stringify({ type: "heartbeat", requestId: "request-1" }),
		);

		expect(runtime.socketGateway.sendSocketMessage).toHaveBeenCalledWith(
			"connection-1",
			{
				type: "session_error",
				code: "internal_error",
				message: "unexpected server error",
			},
		);
		expect(consoleError).toHaveBeenCalled();
	});

	it("reports websocket readiness failures as internal session errors", async () => {
		runtime.ready = Promise.reject(new Error("storage migration failed"));
		runtimeMocks.createCoordinatorRuntime.mockReturnValue(runtime);
		coordinator = new SyncCoordinator(testDurableObjectState(), {} as Env);

		await coordinator.webSocketMessage(
			{} as WebSocket,
			JSON.stringify({ type: "heartbeat", requestId: "request-1" }),
		);

		expect(runtime.socketGateway.sendSocketMessage).toHaveBeenCalledWith(
			"connection-1",
			expect.objectContaining({
				type: "session_error",
				code: "internal_error",
			}),
		);
		expect(runtime.socketMessageHandler.handle).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalled();
	});

	it("preserves invalid_json for malformed websocket payloads", async () => {
		await coordinator.webSocketMessage({} as WebSocket, "{");

		expect(runtime.socketGateway.sendSocketMessage).toHaveBeenCalledWith(
			"connection-1",
			{
				type: "session_error",
				code: "invalid_json",
				message: "websocket message must be valid json",
			},
		);
		expect(runtime.socketMessageHandler.handle).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("does not reject when websocket termination cleanup fails", async () => {
		runtime.useCases.handleSocketClose.mockRejectedValueOnce(
			new Error("health flush scheduling failed"),
		);

		await expect(
			coordinator.webSocketClose({} as WebSocket, 1000, "", true),
		).resolves.toBeUndefined();
		await expect(
			coordinator.webSocketError({} as WebSocket, new Error("socket failure")),
		).resolves.toBeUndefined();

		expect(runtime.socketMessageHandler.handleDisconnect).toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalled();
	});

	it("does not reject when websocket termination readiness fails", async () => {
		runtime.ready = Promise.reject(new Error("storage migration failed"));
		runtimeMocks.createCoordinatorRuntime.mockReturnValue(runtime);
		coordinator = new SyncCoordinator(testDurableObjectState(), {} as Env);

		await expect(
			coordinator.webSocketError({} as WebSocket, new Error("socket failure")),
		).resolves.toBeUndefined();

		expect(runtime.useCases.handleSocketClose).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalled();
	});
});

function createRuntime() {
	return {
		app: {
			fetch: vi.fn(async () => new Response("ok")),
		},
		useCases: {
			commitMutation: vi.fn(async () => ({})),
			handleSocketClose: vi.fn(async () => {}),
		},
		socketMessageHandler: {
			handle: vi.fn(async () => {}),
			handleDisconnect: vi.fn(),
		},
		socketGateway: {
			connectionIdFor: vi.fn(() => "connection-1"),
			sendSocketMessage: vi.fn(() => true),
		},
		ready: Promise.resolve(),
	};
}

function testDurableObjectState(): DurableObjectState {
	return {
		id: {
			toString: () => "durable-object-1",
		},
	} as unknown as DurableObjectState;
}
