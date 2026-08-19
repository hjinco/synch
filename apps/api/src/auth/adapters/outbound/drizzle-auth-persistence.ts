import { asc, eq } from "drizzle-orm";

import type { AppDb } from "../../../db/client";
import * as schema from "../../../db/d1";
import type { AuthPersistence } from "../../application/ports/outbound/auth-persistence";

export class DrizzleAuthPersistence implements AuthPersistence {
	constructor(private readonly db: AppDb) {}

	async readDefaultOrganizationIdForUser(userId: string): Promise<string | null> {
		const rows = await this.db
			.select({
				organizationId: schema.member.organizationId,
			})
			.from(schema.member)
			.where(eq(schema.member.userId, userId))
			.orderBy(asc(schema.member.createdAt))
			.limit(1);

		return rows[0]?.organizationId ?? null;
	}

	async setSessionActiveOrganization(
		sessionId: string,
		organizationId: string,
	): Promise<void> {
		await this.db
			.update(schema.session)
			.set({ activeOrganizationId: organizationId })
			.where(eq(schema.session.id, sessionId));
	}
}
