# Sync cursor checkpointing

`last_pulled_cursor` is a local-vault checkpoint, not a record of the latest
server cursor seen by the client.

## Meaning

When a local vault stores `last_pulled_cursor = N`, it means:

- every server entry state with `updated_seq <= N` has been processed without
  gaps;
- the next pull can safely request changes after `N`;
- any failure or deferred dependency must leave the checkpoint at the last
  gap-free cursor.

This is stronger than "my last push was accepted at cursor N".

## Push accepted cursors

A push response cursor only proves that the submitted mutation was committed at
that position in the vault-wide server stream. It does not prove that the client
has applied earlier server cursors.

Example:

```text
local last_pulled_cursor = 10

other local vault commits B -> server cursor 11
this local vault has not pulled 11 yet

this local vault pushes A -> accepted at server cursor 12
```

If the client stores `last_pulled_cursor = 12` here, cursor 11 can be skipped
forever. The local A state may be correct, but the checkpoint would falsely say
that all changes through 12 were applied.

## Current rule

Push must not treat the maximum accepted cursor as a checkpoint.

Push may update local entry state for accepted mutations and clear dirty
mutations.

Push may advance `last_pulled_cursor` only for the accepted cursor prefix that is
contiguous with the current checkpoint. If the current checkpoint is `N`, accepted
cursors `N + 1`, `N + 2`, and so on may be checkpointed until the first gap.
Accepted cursors after a gap must not be checkpointed by push.

Examples:

```text
local last_pulled_cursor = 10
push accepted cursors = [11, 12]

safe next last_pulled_cursor = 12
```

```text
local last_pulled_cursor = 10
push accepted cursors = [12]

safe next last_pulled_cursor = 10
follow-up pull required to process cursor 11
```

When a push leaves accepted cursors beyond the safe contiguous prefix, the client
should schedule a pull so the pull path can apply the vault-wide stream and
advance the checkpoint only after a gap-free window is complete.

The server still returns accepted cursors for commit results because clients need
them for local entry state, reporting, and this contiguous-prefix checkpoint
optimization.

## Partial pull application

Payloads are prepared and applied in dependency groups within a metadata window.
Each group owns its entry-state rollback boundary. A later group failure leaves
completed independent groups in place, including any preserved local conflict
copies, while keeping the cursor at the previous safe checkpoint. Retrying lists
those states again and skips the download/write for entries already applied to
the same remote revision and content. A group's completion alone must not advance
the cursor past unfinished or deferred entries.

## Future optimization

Further optimizations must preserve the gap-free invariant.

Potential optimizations:

- coalesce repeated push-triggered pulls so a burst of local changes schedules
  one follow-up pull;
- skip blob fetch/decrypt during pull when an entry state is already known to be
  identical to the accepted local state.

Do not add an optimization that treats `max(accepted.cursor)` as a safe
checkpoint.
