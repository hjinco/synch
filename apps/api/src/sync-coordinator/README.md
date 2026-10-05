# Coordinator persistence boundaries

Application services choose which facts to read, invoke domain policies, and order writes. SQLite adapters implement table operations and read projections. They do not own staging, mutation, purge, or repair workflows.

- `EntryStore` owns current entry reads and writes.
- `EntryVersionStore` owns version reads, conflict-aware insertion, and deletion.
- `BlobStore` owns blob records. Delete operations return the rows actually removed.
- `CoordinatorStateStore` owns cursor, usage, limits, pause state, and GC timestamps.
- `LocalVaultConnectionStore` owns connection records.
- `BlobReferenceStore`, GC queries, and health queries provide cross-table facts and projections.

`CoordinatorUnitOfWork.run()` supplies stores bound to one synchronous SQLite transaction. Services use this boundary for related writes; SQLite implements commit and rollback for both Node and Durable Objects. SQL and Drizzle handles do not cross the application port. Read projections may use joins, aggregates, and correlated subqueries instead of fetching whole tables into services.

Blob record operations shared by staging, abort, repair, and GC live in `application/services/blob-record-operations.ts`. Usage is adjusted from the actual deletion result inside the same transaction, so skipped or repeated deletes cannot double-decrement it. Mutation cursor allocation belongs to `MutationService`; entries, sampled versions, blob states, and the final cursor commit together.

Replacing an entry's current blob starts retirement when no current entry references it. Retained history may still pin that pending-delete blob. GC additionally requires retained history to expire before collecting the ciphertext. These are deliberately different transitions.

GC queries apply their SQL collection predicate before the batch limit to avoid starving collectible rows behind pinned rows. They return reference facts for domain validation. Conditional deletion rechecks the predicate at write time. `blob-collectability.test.ts` checks the SQL projection against the domain over state, reference, retention, and grace-period boundaries.

Object storage calls remain outside database transactions. The unit of work is not an asynchronous request lock; runtime serialization is a separate boundary. GC removes successful objects before their metadata, while stale-staging repair removes metadata before object I/O. Preserve those existing orderings and their failure/retry behavior when changing the services.

Tests use the production application operations rather than implementing domain decisions in storage fakes. Real SQLite tests exercise multi-table rollback and accounting; Cloudflare integration and Node E2E tests exercise the runtime wiring.

## Operator sync pause

Managed deployments expose these routes when `ADMIN_TOKEN` is configured. All
require `Authorization: Bearer <ADMIN_TOKEN>`:

- `GET /admin/v1/vaults/:vaultId/sync-state`
- `POST /admin/v1/vaults/:vaultId/sync-pause` with JSON `{ "reason": "excessive requests" }`
- `POST /admin/v1/vaults/:vaultId/sync-resume`

Pause uses the existing `coordinator_state.sync_paused_at` and
`sync_pause_reason` fields, with a `manual: ` reason prefix. No migration is
needed. Repeated pause calls retain the original timestamp and reason and retry
closing sockets; repeated resume calls are safe. Pause/resume return
`{ "syncPause": null | { "pausedAt": number, "reason": string } }`.
A missing coordinator state returns 404. A pre-existing repair pause returns
409 `sync_repair_required` and is neither overwritten nor cleared. Sync repair
does not clear manual pauses.

Pause closes existing sockets with 1013 and the legacy repair-pause reason so
existing clients preserve their vault link. Token issuance, socket admission,
control messages, and blob access reject paused vaults; commits recheck after
asynchronous blob preflight before writing. Data is retained. Already-started
object transfers and maintenance are not cancelled, and clients may continue
sending retry requests. This is a sync admission control, not an edge rate limit.

Example (variables supplied by the operator):

```sh
curl --fail-with-body -X POST "$API_URL/admin/v1/vaults/$VAULT_ID/sync-pause" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"excessive requests"}'

curl --fail-with-body -X POST "$API_URL/admin/v1/vaults/$VAULT_ID/sync-resume" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
