# Query execution

Runs validated SQL against the user's database. Returns results to the frontend without sending them anywhere else.

## Inputs

- A `ValidatedSql` struct from the validator
- The connection profile used to extract the schema
- Execution settings: row cap, timeout

## Outputs

- A result set, returned to the frontend for display
- A history record (question, SQL, row count, duration) written to the schema store

## Mechanism

A read-only transaction is opened with the configured timeout. The query is executed. Results are streamed back row-by-row up to the row cap, then truncated.

```rust
async fn execute(
    sql: &ValidatedSql,
    conn: &Connection,
    settings: ExecutionSettings,
) -> Result<ExecutionResult, ExecutionError> {
    let mut tx = conn.begin_read_only().await?;
    tx.set_statement_timeout(settings.timeout).await?;
    let stream = sqlx::query(&sql.text).fetch(&mut tx).take(settings.row_cap);
    // ... collect into ExecutionResult ...
    tx.rollback().await?;  // read-only, but we explicitly rollback to be safe
    Ok(result)
}
```

The transaction is rolled back at the end regardless of outcome. Read-only transactions cannot make changes, but explicitly rolling back is defense in depth and clearer in audit.

## Settings

- `row_cap`: default 1,000. User-configurable up to 100,000 in settings. Above 100,000, results are not streamed to the UI grid (which would be unusable) but the user can opt to export results to a local CSV file. The export still happens on-machine; the file is written to a user-chosen location.
- `timeout`: default 30 seconds. User-configurable up to 5 minutes.

## Pre-execution `EXPLAIN` (Phase 3 enhancement)

Before actually executing, we optionally run `EXPLAIN` on the query in the same read-only transaction. This catches schema mismatches and obvious mistakes (missing indexes that would make the query take forever) without touching real data. `EXPLAIN` is cheap on most databases.

If `EXPLAIN` reports an issue (Postgres returns errors on bad queries here), surface it before running the actual query. Also surface estimated row count if available; if it dwarfs the user's row cap, warn them.

## What happens to results

Results live in two places only:
1. **Frontend state.** Displayed in a virtualized grid. Cleared when the user navigates away or runs a new query.
2. **Optional user export.** If the user clicks "export," a CSV is written to a path of their choosing.

Results are never:
- Written to the schema store
- Included in logs
- Sent to the LLM
- Sent to us

The `history` table records that the query was executed and how many rows came back, but not the rows themselves.

## Errors

| Error | UI behavior |
|---|---|
| Timeout | "Query timed out after Ns. You can increase the timeout in settings." |
| Permission denied (write attempted) | "Database refused the query. This should not happen if validation passed; please report this." (and indeed it shouldn't — this would indicate a validator gap) |
| Connection lost | "Lost connection to database. Reconnect and try again." |
| Row cap reached | Results are shown with a banner: "Showing first N rows. Increase row cap in settings or export to CSV for full results." |

## Concurrency

Only one query per connection executes at a time in v1. The user can have multiple connection profiles, each with their own active query, but a single profile is single-threaded. This matches user expectation (you don't run two analytical queries against the same DB simultaneously) and avoids needing connection pooling complexity.
