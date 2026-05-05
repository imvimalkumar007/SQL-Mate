# Schema extraction

Extracts the canonical schema model from the user's database, using only metadata queries. Never reads row data.

## Inputs

- A connection profile: dialect, host, port, database name, username, and the password. (Phase 2 stores the password inside the SQLCipher-encrypted local store rather than the OS keychain — see ADR 0008.)
- The user's confirmation, given through the UI, that they want to extract.

## Outputs

- A `SchemaModel` written to the schema store. See `docs/ARCHITECTURE.md` for the type.
- A summary returned to the UI: number of schemas, tables, columns, foreign keys.

## Mechanism

Connection is opened from the user's machine using the appropriate database driver:

- Postgres: `sqlx` with `postgres` feature
- MySQL: `sqlx` with `mysql` feature
- SQLite: `sqlx` with `sqlite` feature
- SQL Server: `tiberius` (sqlx's MSSQL support is limited)

The connection is opened with a read-only intent flag where the protocol supports it (`default_transaction_read_only=on` for Postgres, equivalent flags elsewhere). This is defense in depth on top of the user-configured read-only role.

A single metadata query is run per dialect. The exact queries are documented in the appendix of this file. They all return one row per column with the columns needed to build the canonical schema model.

The result is parsed into the canonical schema model. No transformations beyond mapping field names. The model is persisted to the schema store keyed by connection profile.

## Permissions required

The user's role needs `SELECT` on the relevant `information_schema` views (or `sys.*` for SQL Server, `pragma_*` for SQLite). In standard configurations every role has this. In tightly locked-down environments it may not — the UI must surface this clearly when the extraction query returns a permissions error.

## Errors and how the UI handles them

| Error | UI behavior |
|---|---|
| Connection refused / DNS failure | "Could not reach database. Check host and port." |
| Authentication failure | "Authentication failed. Check username and password." |
| Permission denied on `information_schema` | "Your database role cannot read schema metadata. Ask a DBA to grant SELECT on `information_schema` (Postgres/MySQL) or equivalent for your database." Show the exact GRANT statement. |
| Empty result (zero tables) | "Connected, but no tables visible to this role. Check that the role has access to a non-system schema." |
| Query timeout | "Schema extraction timed out. Very large schemas may take longer; retry with a longer timeout in settings." |

## Open questions for implementation

- How do we handle databases with thousands of schemas (multi-tenant Postgres setups)? Default to extracting only the schemas the user explicitly selects, and offer a "show all schemas" toggle that lists schema names without extracting their tables until the user clicks one.
- Snowflake and BigQuery have multi-database hierarchies (database → schema → table) that don't quite fit the two-level model. Decide in their respective extractor implementations.
- Materialized views, foreign tables, and partitioned tables: include in v1 with a `kind` field on `Table`. Indexes are not in the model for v1.

## Appendix: extraction queries by dialect

These are kept in the doc so they can be reviewed without reading the implementation. The implementation must produce results equivalent to running these queries.

### Postgres

```sql
SELECT
  c.table_schema,
  c.table_name,
  c.column_name,
  c.ordinal_position,
  c.data_type,
  c.is_nullable,
  c.column_default,
  CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key,
  fk.foreign_table_schema,
  fk.foreign_table_name,
  fk.foreign_column_name
FROM information_schema.columns c
LEFT JOIN (
  SELECT kcu.table_schema, kcu.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
) pk
  ON c.table_schema = pk.table_schema
 AND c.table_name = pk.table_name
 AND c.column_name = pk.column_name
LEFT JOIN (
  SELECT
    kcu.table_schema, kcu.table_name, kcu.column_name,
    ccu.table_schema AS foreign_table_schema,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
) fk
  ON c.table_schema = fk.table_schema
 AND c.table_name = fk.table_name
 AND c.column_name = fk.column_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position;
```

### MySQL / MariaDB

```sql
SELECT
  c.TABLE_SCHEMA AS table_schema,
  c.TABLE_NAME AS table_name,
  c.COLUMN_NAME AS column_name,
  c.ORDINAL_POSITION AS ordinal_position,
  c.DATA_TYPE AS data_type,
  c.IS_NULLABLE AS is_nullable,
  c.COLUMN_DEFAULT AS column_default,
  CASE WHEN c.COLUMN_KEY = 'PRI' THEN TRUE ELSE FALSE END AS is_primary_key,
  kcu.REFERENCED_TABLE_SCHEMA AS foreign_table_schema,
  kcu.REFERENCED_TABLE_NAME AS foreign_table_name,
  kcu.REFERENCED_COLUMN_NAME AS foreign_column_name
FROM information_schema.COLUMNS c
LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA
 AND c.TABLE_NAME = kcu.TABLE_NAME
 AND c.COLUMN_NAME = kcu.COLUMN_NAME
 AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;
```

### SQL Server

See appendix in earlier design notes; same shape, dialect-specific catalog views.

### SQLite

```sql
SELECT
  m.name AS table_name,
  ti.name AS column_name,
  ti.cid AS ordinal_position,
  ti.type AS data_type,
  CASE WHEN ti."notnull" = 0 THEN 'YES' ELSE 'NO' END AS is_nullable,
  ti.dflt_value AS column_default,
  CASE WHEN ti.pk > 0 THEN 1 ELSE 0 END AS is_primary_key,
  fk."table" AS foreign_table_name,
  fk."to" AS foreign_column_name
FROM sqlite_master m
JOIN pragma_table_info(m.name) ti
LEFT JOIN pragma_foreign_key_list(m.name) fk ON fk."from" = ti.name
WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, ti.cid;
```
