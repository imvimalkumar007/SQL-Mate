# SQL validation

Parses generated SQL and enforces two constraints: it must be read-only, and it must reference only entities that exist in the user's schema. This is a load-bearing security control. Any change here requires a security review.

## Implementation

Two layers, both must pass:

### Layer 1: Rust pre-parse

A fast syntactic check in Rust that rejects obvious violations before invoking the sidecar. Uses string-level checks for the leading keyword. Catches malformed responses early.

Rejects (case-insensitively, ignoring leading whitespace and comments):
- Anything not starting with `SELECT` or `WITH`
- The presence of any of these keywords as standalone tokens anywhere: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, `EXECUTE`, `EXEC`, `CALL`, `MERGE`, `LOCK`, `RENAME`, `COMMENT`, `COPY`, `LOAD`, `IMPORT`, `EXPORT`, `BACKUP`, `RESTORE`

This layer can produce false positives (a `WITH` CTE that does an `INSERT` would be caught even if the leading word is `WITH`, which is correct). False positives are acceptable here; we err on the side of rejection.

### Layer 2: Python sidecar with `sqlglot`

The SQL is sent to the sidecar over stdin/stdout JSON. The sidecar parses it with `sqlglot` using the appropriate dialect, walks the AST, and rejects:

- Any node type other than `Select`, `Subquery`, `CTE`, `Union`, `Intersect`, `Except`, plus the supporting expression node types
- Any `Insert`, `Update`, `Delete`, `Drop`, `Create`, `Alter`, `Truncate`, `Merge`, `Command`, `Use`, `Set`, `Pragma`, `Transaction` node
- `SELECT ... INTO` (which writes to a new table)
- CTEs whose body is a non-`Select` statement
- Calls to procedures or functions on a denylist (dialect-specific list of procedural extensions like `pg_read_file`, `xp_cmdshell`, `LOAD_FILE`)

Then it walks the AST again and collects every table reference and every column reference. For each:

- Resolve the qualified name against the schema model
- If the table does not exist in the schema, reject with `UnknownTable(name)`
- If the column does not exist on the resolved table, reject with `UnknownColumn(table, column)`

Schema-qualified names are required for ambiguous cases. The validator uses the dialect's default schema resolution rules.

System tables (`information_schema.*`, `pg_catalog.*`, `sys.*`, `sqlite_master`) are explicitly rejected. They are not in the user's schema model and the LLM should never need to query them.

## Output

On success, a `ValidatedSql` struct containing the original SQL plus the list of referenced tables (used for the execution module's row-cap heuristic).

On failure, a structured error with a category and human-readable message. The UI displays the message and offers to send the error back to the LLM as a follow-up: "The previous query referenced a table that does not exist. Try again."

## Why a Python sidecar

`sqlglot` is the best AST-level multi-dialect SQL parser available. It supports Postgres, MySQL, SQL Server, SQLite, Snowflake, BigQuery, Redshift, and more. There is no equivalent in the Rust ecosystem yet (`sqlparser-rs` exists but lags on dialect coverage and AST manipulation). See `docs/decisions/0004-sqlglot-for-validation.md` for the full rationale.

The sidecar is started on app launch and held open. It receives one JSON message per validation request and replies with one JSON message. Communication is line-delimited JSON over stdin/stdout. No network listening.

## Test cases

Validation is the most heavily tested module. The test suite includes:

1. **Positive cases.** Real queries from a corpus of analytical SQL across all supported dialects must pass.
2. **Negative cases — write statements.** Every `INSERT`, `UPDATE`, `DELETE`, `DROP`, etc. must be rejected, including obfuscated forms (`/* SELECT */ DROP TABLE x`, `SELECT 1; DROP TABLE x`, `WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`).
3. **Negative cases — system tables.** Queries against `information_schema`, `pg_catalog`, `sys.*`, `sqlite_master` must be rejected.
4. **Negative cases — hallucinated entities.** Queries referencing tables or columns not in the schema must be rejected.
5. **Dialect-specific.** Postgres `COPY ... TO PROGRAM`, SQL Server `xp_cmdshell`, MySQL `LOAD DATA`, SQLite `ATTACH DATABASE` must all be rejected.
6. **Edge cases.** Empty string, only whitespace, only comments, multiple statements, recursive CTEs, lateral joins.

This test suite must be green before any release.
