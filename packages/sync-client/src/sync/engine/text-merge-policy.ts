const AUTO_MERGE_TEXT_EXTENSIONS = new Set([".md"]);

export function isAutoMergeTextPath(path: string): boolean {
  return AUTO_MERGE_TEXT_EXTENSIONS.has(extensionOf(path));
}

function extensionOf(path: string): string {
  const fileName = path.split("/").pop() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return "";
  }
  return fileName.slice(dotIndex).toLowerCase();
}
