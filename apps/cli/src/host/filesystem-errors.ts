/** Only these errors establish absence; permission and I/O errors must propagate. */
export function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}
