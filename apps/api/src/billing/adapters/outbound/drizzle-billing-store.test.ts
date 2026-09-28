import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createLibsqlDb } from "../../../db/client";
import * as schema from "../../../db/d1";
import type { PolarSubscriptionUpsertInput } from "../../application/dto/billing";
import { DrizzleBillingStore } from "./drizzle-billing-store";

let client: Client;
afterEach(() => client?.close());

async function setup() {
	client = createClient({ url: ":memory:" });
	await migrate(drizzle(client), {
		migrationsFolder: fileURLToPath(new URL("../../../../drizzle", import.meta.url).href),
	});
	const db = createLibsqlDb(client);
	await db.insert(schema.organization).values(["org-a", "org-b"].map((id) => ({
		id, name: id, slug: id, createdAt: new Date(),
	})));
	return { db, store: new DrizzleBillingStore(db) };
}

function subscription(organizationId: string): PolarSubscriptionUpsertInput {
	return {
		id: `sub-${organizationId}`, productId: "starter-product", organizationId,
		polarCustomerId: "same-customer", polarSubscriptionId: `polar-sub-${organizationId}`,
		polarCheckoutId: null, status: "active", periodStart: null, periodEnd: null, cancelAtPeriodEnd: false,
	};
}

describe("DrizzleBillingStore", () => {
	it("keeps subscription webhooks idempotent", async () => {
		const { db, store } = await setup();
		await store.upsertPolarSubscription(subscription("org-a"));
		await store.upsertPolarSubscription({ ...subscription("org-a"), status: "canceled" });

		expect(await db.select().from(schema.polarSubscription)).toEqual([
			expect.objectContaining({ organizationId: "org-a", status: "canceled" }),
		]);
		expect(await store.readOrganizationPolarCustomerId("org-a")).toBe("same-customer");
	});

	it("does not leave a subscription behind when its customer belongs to another organization", async () => {
		const { db, store } = await setup();
		await store.upsertPolarSubscription(subscription("org-a"));

		await expect(store.upsertPolarSubscription(subscription("org-b"))).rejects.toThrow();

		expect(await db.select().from(schema.polarSubscription)).toEqual([
			expect.objectContaining({ organizationId: "org-a", polarCustomerId: "same-customer" }),
		]);
		expect(await store.readOrganizationPolarCustomerId("org-b")).toBeNull();
	});
});
