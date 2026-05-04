# Glossary

Terms used throughout the project that have a specific meaning here. When in doubt, use these definitions.

**Canonical schema model.** The intermediate representation of a database schema used internally. Defined in `docs/ARCHITECTURE.md` under "Canonical schema model." Every ingestion path produces this; every consumer reads this.

**Dialect.** The flavor of SQL spoken by a specific database. Postgres, MySQL, SQL Server, SQLite, Snowflake, BigQuery, Redshift. Validation, extraction, and prompt composition are all dialect-aware.

**Excluded entity.** A schema, table, or column that the user has marked as off-limits. Excluded entities are never included in any LLM request and never queryable through the app.

**Extraction.** The process of obtaining a schema model. Live extraction means connecting to a database and running metadata queries. File-based extraction (out of scope for v1) means parsing a SQL DDL, PDF, or SVG file.

**LLM call path.** The code path that ends in an HTTPS request to an LLM provider. Subject to the strictest review because anything that lands here leaves the user's machine.

**Provider.** An LLM service (Anthropic, OpenAI, Google, etc.) or any service exposing an OpenAI-compatible API. Configured by the user with their own API key.

**Read-only transaction.** A database transaction explicitly marked read-only at the database protocol level. For Postgres: `SET TRANSACTION READ ONLY`. For MySQL: `START TRANSACTION READ ONLY`. For SQL Server: `SET TRANSACTION ISOLATION LEVEL SNAPSHOT` plus permission-level enforcement. Used for both `EXPLAIN` checks and actual query execution.

**Redaction.** The process of replacing sensitive table or column names with obfuscated identifiers before sending to the LLM, and reversing that mapping when the response comes back. Per-entity, opt-in.

**Schema slice.** The subset of the canonical schema model included in a single LLM request. For small databases this is the whole schema. For large ones it is the relevant tables selected by the retriever, plus their foreign-key neighbors.

**Sensitive entity.** A schema, table, or column that the user has marked as sensitive but not excluded. Included in LLM requests with an obfuscated name. Distinct from excluded.

**Sidecar.** The Python child process that hosts `sqlglot` for SQL validation. Long-lived, communicates with the Rust core over stdin/stdout JSON.

**Validator.** The module that parses generated SQL and enforces read-only and schema-grounded constraints. Implemented partly in Rust (fast first-pass) and partly in the Python sidecar (`sqlglot` AST analysis).
