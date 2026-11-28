import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SyncBlobClient } from "../../../../packages/sync-client/src/sync/remote/blob-client";
import { SyncRealtimeClient } from "../../../../packages/sync-client/src/sync/remote/realtime-client";
import {
  createCommit, createRealtimeSession, createToken, encryptRemoteMetadata, encryptTestBlob, hashText, TEST_VAULT_KEY,
} from "../../../../packages/sync-client/src/sync/engine/__tests__/pull-service/helpers";
import { CliAppContext } from "../app/context";
import { runPull } from "./pull";

it("replaces local edits with the remote version and can pull again from the saved cursor", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "synch-pull-"));
  const vaultPath = path.join(temporary, "vault");
  fs.mkdirSync(vaultPath);
  const ctx = new CliAppContext({
    vaultPath, credentialsPath: path.join(temporary, "credentials.json"),
    logger: { log: vi.fn(), error: vi.fn() },
  });
  try {
    const token = createToken();
    vi.spyOn(ctx.authManager, "initialize").mockResolvedValue();
    vi.spyOn(ctx.authManager, "getReadiness").mockReturnValue({ state: "verified", token: token.token });
    vi.spyOn(ctx.authManager, "getAuthSessionToken").mockReturnValue(token.token);
    vi.spyOn(ctx.syncTokenManager, "getTokenForActiveRemoteVault").mockResolvedValue(token);
    vi.spyOn(ctx.remoteVaultManager, "getActiveSession").mockReturnValue({
      summary: { vaultId: token.vaultId, vaultName: "vault", activeKeyVersion: 1, bootstrappedAt: null },
      remoteVaultKey: TEST_VAULT_KEY,
    });
    vi.spyOn(ctx.remoteVaultManager, "getRemoteVaultId").mockReturnValue(token.vaultId);
    const open = vi.spyOn(SyncRealtimeClient.prototype, "openSession");
    const download = vi.spyOn(SyncBlobClient.prototype, "downloadBlob");
    const scan = vi.spyOn(ctx.vaultAdapter, "listFiles");
    const upload = vi.spyOn(SyncBlobClient.prototype, "uploadBlob");
    const note = path.join(vaultPath, "note.md");
    const bodies = ["Title\n\nOriginal\n", "Remote title\n\nOriginal\n"];
    for (const [index, body] of bodies.entries()) {
      const revision = index + 1;
      const blobId = "blob-" + revision;
      const commit = createCommit({
        cursor: revision, entryId: "note", revision, blobId,
        encryptedMetadata: await encryptRemoteMetadata({
          entryId: "note", revision, blobId, path: "note.md", hash: await hashText(body),
        }),
      });
      download.mockResolvedValueOnce(await encryptTestBlob(blobId, new TextEncoder().encode(body)));
      open.mockResolvedValueOnce({
        ...createRealtimeSession({ pages: [{ cursor: revision, commits: [commit], hasMore: false }] }),
        serverCursor: revision,
      });
    }
    open.mockResolvedValueOnce({
      ...createRealtimeSession({ pages: [{ cursor: 2, commits: [], hasMore: false }] }),
      serverCursor: 2,
    });

    await runPull(ctx);
    expect(fs.readFileSync(note, "utf8")).toBe(bodies[0]);
    fs.writeFileSync(note, "Title\n\nLocal edit\n");
    ctx.engine.invalidateDeviceFileRules();
    await runPull(ctx);
    expect(fs.readFileSync(note, "utf8")).toBe(bodies[1]);
    expect(await ctx.engine.hasPendingMutations()).toBe(false);
    await expect(runPull(ctx)).resolves.toBe(0);
    expect(open.mock.calls.map(([, , cursor]) => cursor)).toEqual([0, 1, 2]);
    expect(scan).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  } finally {
    await ctx.close();
    vi.restoreAllMocks();
    fs.rmSync(temporary, { force: true, recursive: true });
  }
});
