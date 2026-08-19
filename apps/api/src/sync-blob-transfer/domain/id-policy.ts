const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isSafeBlobId(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length > 0 && SAFE_ID_PATTERN.test(trimmed);
}
