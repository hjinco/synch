export type SocketSessionIdentity = {
	userId: string;
	localVaultId: string;
};

/** A local vault may have only one active sync connection per user. */
export function shouldReplaceSocketSession(
	existing: SocketSessionIdentity,
	incoming: SocketSessionIdentity,
): boolean {
	return (
		existing.userId === incoming.userId &&
		existing.localVaultId === incoming.localVaultId
	);
}
