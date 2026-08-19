import { describe, expect, it } from "vitest";

import { selectSyncWebSocketProtocol } from "./request-auth";

describe("sync websocket protocol selection", () => {
	it("selects the sync websocket protocol", () => {
		const request = new Request("https://example.com", {
			headers: {
				"sec-websocket-protocol": "synch.v1, synch.auth.token",
			},
		});
		expect(selectSyncWebSocketProtocol(request)).toBe("synch.v1");
	});

	it("does not echo the auth protocol", () => {
		const request = new Request("https://example.com", {
			headers: { "sec-websocket-protocol": "synch.auth.token" },
		});
		expect(selectSyncWebSocketProtocol(request)).toBeNull();
	});
});
