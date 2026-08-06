import { webcrypto } from "node:crypto";

import "fake-indexeddb/auto";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}

if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
}
