import { describe, expect, it, vi } from "vitest";

import {
	createCoordinatorService,
	createMockCoordinatorSocketService,
	createTestCoordinatorState,
	testSocketSession,
	testWebSocket,
} from "../../test-helpers";

describe("coordinator entry-state sync", () => {
	it("lists entry-state delta pages over the websocket control channel", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn(() => session),
			sendSocketMessage: vi.fn(),
		});
		const stateRepository = createTestCoordinatorState({
			currentCursor: vi.fn(() => 10),
			countEntryStates: vi.fn(() => 1),
			listEntryStates: vi.fn(() => [
				{
					entry_id: "entry-1",
					revision: 2,
					blob_id: "blob-1",
					encrypted_metadata: "metadata",
					deleted: false,
					updated_seq: 4,
					updated_at: 123,
				},
			]),
		});
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "list_entry_states",
				requestId: "request-entry-states",
				sinceCursor: 2,
				targetCursor: null,
				after: null,
				limit: 100,
			}),
		);

		expect(stateRepository.listEntryStates).toHaveBeenCalledWith(2, 10, null, 101);
		expect(stateRepository.countEntryStates).toHaveBeenCalledWith(2, 10);
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith("test", {
			type: "entry_states_listed",
			requestId: "request-entry-states",
			targetCursor: 10,
			totalEntries: 1,
			hasMore: false,
			nextAfter: null,
			entries: [
				{
					entryId: "entry-1",
					revision: 2,
					blobId: "blob-1",
					encryptedMetadata: "metadata",
					deleted: false,
					updatedSeq: 4,
					updatedAt: 123,
				},
			],
		});
	});

	it.each([
		{
			name: "since cursor ahead of the server",
			sinceCursor: 11,
			targetCursor: null,
			code: "cursor_ahead_of_server",
		},
		{
			name: "target cursor ahead of the server",
			sinceCursor: 2,
			targetCursor: 11,
			code: "invalid_cursor_range",
		},
		{
			name: "target cursor behind the since cursor",
			sinceCursor: 8,
			targetCursor: 7,
			code: "invalid_cursor_range",
		},
	])("rejects an invalid entry-state range: $name", async (input) => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn(() => session),
			sendSocketMessage: vi.fn(),
		});
		const listEntryStates = vi.fn();
		const stateRepository = createTestCoordinatorState({
			currentCursor: vi.fn(() => 10),
			listEntryStates,
		});
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "list_entry_states",
				requestId: "request-entry-states",
				sinceCursor: input.sinceCursor,
				targetCursor: input.targetCursor,
				after: null,
				limit: 100,
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith(
			"test",
			expect.objectContaining({
				type: "entry_states_list_failed",
				requestId: "request-entry-states",
				code: input.code,
			}),
		);
		expect(listEntryStates).not.toHaveBeenCalled();
	});
});
