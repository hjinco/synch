import type { CoordinatorPurgeWriter as CoordinatorPurgeWriterPort } from "../../application/ports/outbound/coordinator-purge-writer";

export type CoordinatorPurgeTransport = {
	purgeVault(vaultId: string): Promise<Response>;
};

export class CoordinatorPurgeWriter implements CoordinatorPurgeWriterPort {
	constructor(private readonly transport: CoordinatorPurgeTransport) {}

	async purgeVault(vaultId: string): Promise<void> {
		const response = await this.transport.purgeVault(vaultId);
		if (!response.ok) {
			throw new Error(`coordinator purge failed with status ${response.status}`);
		}
	}
}
