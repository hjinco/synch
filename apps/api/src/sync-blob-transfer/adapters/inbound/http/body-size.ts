export const BLOB_SIZE_HEADER = "x-blob-size";

export function parseBlobSizeHeader(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}
	const size = Number(trimmed);
	return Number.isSafeInteger(size) && size >= 0 ? size : null;
}
