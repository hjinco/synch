import { asc, eq } from "drizzle-orm";

import type { AppDb } from "../db/client";
import * as schema from "../db/d1";

export async function readDefaultOrganizationIdForUserId(
	db: AppDb,
	userId: string,
): Promise<string | null> {
	const rows = await db
		.select({
			organizationId: schema.member.organizationId,
		})
		.from(schema.member)
		.where(eq(schema.member.userId, userId))
		.orderBy(asc(schema.member.createdAt))
		.limit(1);

	return rows[0]?.organizationId ?? null;
}

export function defaultOrganizationSlug(userId: string): string {
	return `user-${userId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}
