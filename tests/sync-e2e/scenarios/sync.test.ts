import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createVault, signUp, type TestVault } from "../harness/account";
import { Device } from "../harness/device";
import { startServer, type Runtime, type TestServer } from "../harness/server";

const selected = process.env.SYNC_E2E_RUNTIME;
if (selected && selected !== "node" && selected !== "cloudflare") throw new Error(`Invalid SYNC_E2E_RUNTIME: ${selected}`);
const runtimes: Runtime[] = selected ? [selected as Runtime] : ["node", "cloudflare"];

for (const runtime of runtimes) describe(`encrypted sync (${runtime})`, () => {
  let server: TestServer;
  let cookie: string;
  let remote: TestVault;
  let a: Device;
  let b: Device;
  let devices: Device[];

  beforeAll(async () => { server = await startServer(runtime); cookie = await signUp(server.baseUrl); });
  afterAll(async () => { await server?.close(); });
  beforeEach(async () => {
    devices = [];
    remote = await createVault(server.baseUrl, cookie);
    a = await device("A", remote.key);
    b = await device("B", await remote.unlock());
  });
  afterEach(async context => {
    if (context.task.result?.state === "fail") {
      console.error(JSON.stringify(await Promise.all(devices.map(device => device.debug())), null, 2));
      console.error(server.logs());
    }
    await Promise.all(devices.map(device => device.close()));
  });
  async function device(name: string, key: Uint8Array) {
    const value = new Device(name, server.baseUrl, remote, key);
    devices.push(value);
    await value.initialize(remote);
    return value;
  }
  async function settle(...clients: Device[]) {
    for (const client of clients) await client.sync();
    for (const client of clients) {
      await expect.poll(() => client.engine.hasPendingMutations()).toBe(false);
      expect(client.errors).toEqual([]);
    }
  }
  async function seed(path = "note.md", content: string | Uint8Array = "one\ntwo\nthree\n") {
    await a.connect();
    await a.write(path, content);
    await settle(a);
    await b.connect();
    await settle(b);
    expect(await b.vault.readBytes(path)).toEqual(await a.vault.readBytes(path));
    await a.disconnect();
    await b.disconnect();
  }
  async function syncInOrder(first: Device, second: Device) {
    await first.connect();
    await settle(first);
    await second.connect();
    await settle(second, first);
  }
  async function stable() {
    const before = await Promise.all([a.snapshot(), b.snapshot()]);
    await settle(a, b, a);
    await a.disconnect(); await b.disconnect();
    await a.connect(); await b.connect();
    await settle(a, b, a);
    expect(await Promise.all([a.snapshot(), b.snapshot()])).toEqual(before);
  }

  it("round-trips text and binary, rename and delete, with ciphertext on the wire", async () => {
    const secret = "private-note-body-40adbbad\n";
    const path = "private-folder-93734/private-note.md";
    await a.connect(); await b.connect();
    await a.write(path, secret);
    await a.write("image.png", new Uint8Array([0, 255, 23, 0, 14]));
    await settle(a, b);
    expect(await b.vault.readText(path)).toBe(secret);
    expect(await b.vault.readBytes("image.png")).toEqual(new Uint8Array([0, 255, 23, 0, 14]));
    expect(a.network.uploads.length).toBeGreaterThan(0);
    expect(b.network.downloads).toEqual(expect.arrayContaining(a.network.uploads));
    for (const text of [...a.network.sent, ...b.network.received, ...a.network.uploads.map(bytes => new TextDecoder().decode(bytes))]) {
      expect(text).not.toContain(path);
      expect(text).not.toContain(secret.trim());
    }
    const id = await a.engine.getEntryIdForPath(path);
    await a.rename(path, "renamed.md");
    await settle(a, b);
    expect(await b.engine.getEntryIdForPath("renamed.md")).toBe(id);
    expect(await b.vault.exists(path)).toBe(false);
    await a.write("renamed.md", "updated\n");
    await settle(a, b);
    expect(await b.vault.readText("renamed.md")).toBe("updated\n");
    await a.remove("renamed.md"); await a.remove("image.png");
    await settle(a, b);
    expect(await b.snapshot()).toEqual({});
    await stable();
  });

  it("skips excluded attachment and folder downloads and catches up when the device reconnects at the same cursor", async () => {
    b.updateFileRules({ includePdf: false, excludedFolders: ["Archive"] });
    await a.connect();
    await a.write("paper.pdf", "desktop PDF");
    await a.write("Archive/notes.md", "archived");
    await a.write("today.md", "visible");
    await settle(a);
    await b.connect();
    await settle(b);
    expect(b.network.downloads).toHaveLength(1);
    expect(await b.vault.readText("today.md")).toBe("visible");
    expect(await b.vault.exists("paper.pdf")).toBe(false);
    expect(await b.vault.exists("Archive/notes.md")).toBe(false);
    expect(await b.store.getCursor()).toBe(await a.store.getCursor());
    await b.disconnect();

    b.updateFileRules({ includePdf: true });
    await b.connect();
    await expect.poll(() => b.vault.exists("paper.pdf")).toBe(true);
    expect(await b.vault.readText("paper.pdf")).toBe("desktop PDF");
    expect(await b.vault.exists("Archive/notes.md")).toBe(false);
    expect(b.network.downloads).toHaveLength(2);
  });

  it("keeps a phone edit through a failed inclusion scan and a subsequent realtime update", async () => {
    await seed("paper.pdf", "base");
    b.updateFileRules({ includePdf: false });
    await a.connect();
    await a.write("paper.pdf", "desktop edit");
    await settle(a);
    await b.connect();
    await settle(b);
    await b.vault.writeText("paper.pdf", "phone-only edit");
    await b.vault.writeText("unrelated.md", "unreadable during scan");
    const read = b.vault.readBytes.bind(b.vault);
    const faultyDisk = vi.spyOn(b.vault, "readBytes").mockImplementation(async (path) => {
      if (path === "unrelated.md") throw new Error("disk read failed");
      return read(path);
    });
    b.updateFileRules({ includePdf: true });
    await expect(b.engine.reconcileOnce()).rejects.toThrow("disk read failed");
    const downloads = b.network.downloads.length;
    await a.write("other.md", "new realtime update");
    await settle(a);
    await expect.poll(() => b.errors.some((error) => String(error).includes("disk read failed"))).toBe(true);
    expect(await b.vault.readText("paper.pdf")).toBe("phone-only edit");
    expect(b.network.downloads).toHaveLength(downloads);
    faultyDisk.mockRestore();
    b.errors.length = 0;
    await b.engine.syncNow();
    await expect.poll(() => b.vault.readText("paper.pdf")).toBe("desktop edit");
    const copies = (await b.vault.listFiles()).filter((file) => file.path.includes(".sync-conflict-"));
    expect(await Promise.all(copies.map((file) => b.vault.readText(file.path)))).toEqual(["phone-only edit"]);
  });

  it("syncs the replacement at a reused path while its original file is excluded", async () => {
    await seed("a.pdf", "original");
    await b.rename("a.pdf", "Archive/a.pdf");
    await b.write("a.pdf", "replacement");
    b.updateFileRules({ excludedFolders: ["Archive"] });
    await syncInOrder(b, a);
    expect(await a.vault.readText("a.pdf")).toBe("replacement");
    expect(await a.vault.exists("Archive/a.pdf")).toBe(false);
    expect(await b.vault.readText("Archive/a.pdf")).toBe("original");

    b.updateFileRules({ excludedFolders: [] });
    await settle(b, a);
    expect(await a.vault.readText("Archive/a.pdf")).toBe("original");
    expect(await a.vault.readText("a.pdf")).toBe("replacement");
    expect(b.conflicts).toEqual([]);
  });

  it("preserves Markdown bytes and the BOM through download, scan and text merge", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    await seed("note.md", encode("\uFEFFone\ntwo\nthree\n"));
    expect((await b.engine.reconcileOnce()).filesQueuedForUpsert).toBe(0);
    await a.write("note.md", encode("\uFEFFONE\ntwo\nthree\n"));
    // The local edit reaches disk before the receiving device delivers its event.
    await b.vault.writeBinary("note.md", encode("\uFEFFone\ntwo\nTHREE\n"));
    await syncInOrder(a, b);
    const expected = encode("\uFEFFONE\ntwo\nTHREE\n");
    expect(await a.vault.readBytes("note.md")).toEqual(expected);
    expect(await b.vault.readBytes("note.md")).toEqual(expected);
    expect((await b.engine.reconcileOnce()).filesQueuedForUpsert).toBe(0);
    expect([...a.conflicts, ...b.conflicts]).toEqual([]);
  });

  it("catches up after offline edits", async () => {
    await seed();
    await a.write("note.md", "offline content\n");
    await a.write("new.md", "new offline file\n");
    await syncInOrder(a, b);
    expect(await b.snapshot()).toEqual(await a.snapshot());
    await stable();
  });

  it("recovers an interrupted download before a scan can upload the truncated note", async () => {
    const path = "note.md";
    const original = "Title\n\nKeep this paragraph.\n";
    const complete = original + "Remote addition.\n";
    await seed(path, original);
    await a.write(path, complete);
    await a.connect();
    await settle(a);

    const uploads = b.network.uploads.length;
    const interrupted = vi.spyOn(b.vault, "writeText").mockImplementationOnce(async (name) => {
      await b.vault.writeBinary(name, new TextEncoder().encode("Title\n"));
      throw new Error("interrupted note write");
    });
    try {
      await b.connect();
      await expect.poll(() => b.errors.some((error) => String(error).includes("interrupted note write"))).toBe(true);
      await b.disconnect();
    } finally {
      interrupted.mockRestore();
    }

    b.errors.length = 0;
    await b.engine.reconcileOnce();
    await b.connect();
    await settle(b, a);
    expect(await b.vault.readText(path)).toBe(complete);
    expect(await a.vault.readText(path)).toBe(complete);
    expect(b.network.uploads).toHaveLength(uploads);
    expect(await b.store.getCursor()).toBe(await a.store.getCursor());
  });

  for (const reversed of [false, true]) {
    const order = reversed ? "B then A" : "A then B";
    it(`merges independent text edits (${order})`, async () => {
      await seed();
      await a.write("note.md", "ONE\ntwo\nthree\n");
      await b.write("note.md", "one\ntwo\nTHREE\n");
      await syncInOrder(...(reversed ? [b, a] as const : [a, b] as const));
      expect(await a.vault.readText("note.md")).toBe("ONE\ntwo\nTHREE\n");
      expect(await b.snapshot()).toEqual(await a.snapshot());
      expect([...a.conflicts, ...b.conflicts]).toEqual([]);
      await stable();
    });

    for (const binary of [false, true]) it(`preserves overlapping ${binary ? "binary" : "text"} edits (${order})`, async () => {
      const path = binary ? "image.png" : "note.md";
      await seed(path);
      const left = binary ? new Uint8Array([0, 255, 1, 128]) : new TextEncoder().encode("left edit\n");
      const right = binary ? new Uint8Array([0, 254, 2, 129]) : new TextEncoder().encode("right edit\n");
      await a.write(path, left); await b.write(path, right);
      const first = reversed ? b : a, second = reversed ? a : b;
      await syncInOrder(first, second);
      expect(await second.vault.readBytes(path)).toEqual(reversed ? right : left);
      const copies = (await second.vault.listFiles()).filter(file => file.path !== path);
      expect(copies).toHaveLength(1);
      expect(await copies[0].readBytes()).toEqual(reversed ? left : right);
      expect(second.conflicts).toHaveLength(1);
      // Conflict copies are deliberately local-only according to the file sync policy.
      expect((await first.vault.listFiles()).map(file => file.path)).toEqual([path]);
      await stable();
    });

    it(`preserves an edit racing with deletion (${order})`, async () => {
      await seed();
      await a.remove("note.md");
      await b.write("note.md", "must survive deletion race\n");
      await syncInOrder(...(reversed ? [b, a] as const : [a, b] as const));
      if (!reversed) {
        expect(await a.vault.exists("note.md")).toBe(false);
        expect(await b.vault.exists("note.md")).toBe(false);
        const copies = await b.vault.listFiles();
        expect(copies).toHaveLength(1);
        expect(await b.vault.readText(copies[0].path)).toBe("must survive deletion race\n");
      } else {
        expect(await a.vault.readText("note.md")).toBe("must survive deletion race\n");
        expect(await b.snapshot()).toEqual(await a.snapshot());
      }
      await stable();
    });

    it(`preserves identity and content for rename versus edit (${order})`, async () => {
      await seed();
      const entryId = await a.engine.getEntryIdForPath("note.md");
      await a.rename("note.md", "moved.md");
      await b.write("note.md", "edited during rename\n");
      await syncInOrder(...(reversed ? [b, a] as const : [a, b] as const));
      const first = reversed ? b : a;
      const second = reversed ? a : b;
      const canonicalPath = await first.engine.getPathForEntryId(entryId!);
      expect(canonicalPath).toBe(reversed ? "note.md" : "moved.md");
      expect(await second.engine.getPathForEntryId(entryId!)).toBe(canonicalPath);
      const contents = await Promise.all((await second.vault.listFiles()).map(file => second.vault.readText(file.path)));
      expect(contents.sort()).toEqual(["edited during rename\n", "one\ntwo\nthree\n"]);
      expect((await first.vault.listFiles()).map(file => file.path)).toEqual([canonicalPath]);
      await stable();
    });
  }

  it("deduplicates identical concurrent edits", async () => {
    await seed();
    await a.write("note.md", "same\n"); await b.write("note.md", "same\n");
    await syncInOrder(a, b);
    expect(await b.snapshot()).toEqual(await a.snapshot());
    expect([...a.conflicts, ...b.conflicts]).toEqual([]);
    expect(await b.vault.listFiles()).toHaveLength(1);
    await stable();
  });

  it("preserves different files independently created at the same path", async () => {
    await a.write("same.md", "left\n"); await b.write("same.md", "right\n");
    await syncInOrder(a, b);
    const contents = await Promise.all((await b.vault.listFiles()).map(file => b.vault.readText(file.path)));
    expect(contents.sort()).toEqual(["left\n", "right\n"]);
    await stable();
  });

  it("rebases after a real stale revision rejection and retries the encrypted commit", async () => {
    await seed();
    await a.write("note.md", "ONE\ntwo\nthree\n");
    await b.write("note.md", "one\ntwo\nTHREE\n");
    const gate = b.network.holdNextCommit();
    try {
      await b.connect();
      const syncing = b.engine.syncNow();
      await expect.poll(() => gate.hasReached(), { timeout: 10_000 }).toBe(true);
      await a.connect(); await settle(a);
      gate.release();
      await syncing;
      await settle(b, a);
      const results = b.network.received.flatMap(text => JSON.parse(text).results ?? []);
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ status: "rejected", code: "stale_revision" })]));
      expect(await a.vault.readText("note.md")).toBe("ONE\ntwo\nTHREE\n");
      expect(await b.snapshot()).toEqual(await a.snapshot());
      await stable();
    } finally { gate.release(); }
  });

  for (const failure of ["wrong key", "tampered blob"] as const) it(`rejects ${failure} without losing local data or skipping the update`, async () => {
    await seed();
    const before = await b.snapshot();
    const checkpoint = await b.store.readSyncConnection();
    await a.write("note.md", "remote replacement\n");
    await a.connect(); await settle(a);
    if (failure === "wrong key") b.key = crypto.getRandomValues(new Uint8Array(32));
    else b.network.tamperBlob = true;
    await b.connect();
    await b.engine.syncNow();
    await expect.poll(() => b.errors.length).toBeGreaterThan(0);
    expect(await b.snapshot()).toEqual(before);
    expect((await b.store.readSyncConnection())?.lastPulledCursor).toBe(checkpoint?.lastPulledCursor);
    await b.disconnect();
    b.key = await remote.unlock(); b.network.tamperBlob = false; b.errors.length = 0;
    await b.connect(); await settle(b);
    expect(await b.vault.readText("note.md")).toBe("remote replacement\n");
    await stable();
  });
});
