export class DeviceFileRulesChangedError extends Error {
  constructor() {
    super("Device file rules changed during sync.");
    this.name = "DeviceFileRulesChangedError";
  }
}

export function captureDeviceFileRulesVersion<T extends number | undefined>(readVersion: () => T) {
  const version = readVersion();
  return {
    version,
    assertCurrent: () => {
      if (readVersion() !== version) throw new DeviceFileRulesChangedError();
    },
  };
}
