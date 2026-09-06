import { afterEach } from "vitest";
import { SyncContentRuntime } from "../sync/core/content-runtime";

const runtimes = new Set<SyncContentRuntime>();

afterEach(async () => {
  const owned = [...runtimes];
  runtimes.clear();
  await Promise.all(owned.map((runtime) => runtime.dispose()));
});

/** Standalone service tests own and release their content runtime. */
export function createTestContentRuntime(): SyncContentRuntime {
  const runtime = new SyncContentRuntime();
  runtimes.add(runtime);
  return runtime;
}
