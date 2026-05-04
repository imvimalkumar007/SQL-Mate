use std::collections::BTreeMap;

use sqlx::postgres::{PgConnectOptions, PgRow};
use sqlx::{ConnectOptions, Connection, Row};

use crate::schema::{
    Column, DbSchema, Dialect, ExtractionSource, ForeignKey, SchemaModel, Table,
};

// Single metadata-only query, copied verbatim from the appendix of
// docs/architecture/schema-extraction.md. Returns one row per column with
// joined PK and FK information.
const EXTRACTION_QUERY: &str = r#"
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
ORDER BY c.table_schema, c.table_name, c.ordinal_position
"#;

#[derive(Debug)]
pub enum ExtractError {
    Connection(String),
    Auth(String),
    PermissionDenied(String),
    EmptyResult,
    Timeout,
    Other(String),
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractError::Connection(msg) => write!(f, "Could not reach database. {msg}"),
            ExtractError::Auth(msg) => {
                write!(f, "Authentication failed. Check username and password. {msg}")
            }
            ExtractError::PermissionDenied(msg) => write!(
                f,
                "Permission denied. Your database role cannot read schema metadata. \
                 Ask a DBA to grant SELECT on information_schema. ({msg})"
            ),
            ExtractError::EmptyResult => write!(
                f,
                "Connected, but no tables visible to this role. \
                 Check that the role has access to a non-system schema."
            ),
            ExtractError::Timeout => write!(f, "Schema extraction timed out."),
            ExtractError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ExtractError {}

#[derive(Debug, Clone)]
pub struct PgConnectionParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

impl PgConnectionParams {
    fn into_options(self) -> PgConnectOptions {
        PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .database(&self.database)
            .username(&self.username)
            .password(&self.password)
    }
}

/// Open the connection and run `SELECT 1`. Used by the UI's "Test connection"
/// button before saving a connection profile.
pub async fn test_connection(params: PgConnectionParams) -> Result<(), ExtractError> {
    let mut conn = params
        .into_options()
        .connect()
        .await
        .map_err(classify_connect_error)?;

    sqlx::query("SELECT 1")
        .execute(&mut conn)
        .await
        .map_err(classify_query_error)?;

    let _ = conn.close().await;
    Ok(())
}

/// Connect with read-only intent and run the metadata-only extraction query.
/// Returns the canonical `SchemaModel`. `connection_id` is recorded into the
/// model's `source` field and must match the persisted connection-profile id.
pub async fn extract_schema(
    params: PgConnectionParams,
    connection_id: &str,
) -> Result<SchemaModel, ExtractError> {
    let mut conn = params
        .into_options()
        .connect()
        .await
        .map_err(classify_connect_error)?;

    // Defense in depth on top of the user-configured read-only role.
    sqlx::query("SET default_transaction_read_only = on")
        .execute(&mut conn)
        .await
        .map_err(classify_query_error)?;

    let rows: Vec<PgRow> = sqlx::query(EXTRACTION_QUERY)
        .fetch_all(&mut conn)
        .await
        .map_err(classify_query_error)?;

    let _ = conn.close().await;

    if rows.is_empty() {
        return Err(ExtractError::EmptyResult);
    }

    build_schema_model(rows, connection_id)
}

fn classify_connect_error(e: sqlx::Error) -> ExtractError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("password authentication") || lower.contains("authentication failed") {
        ExtractError::Auth(msg)
    } else {
        ExtractError::Connection(msg)
    }
}

fn classify_query_error(e: sqlx::Error) -> ExtractError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("permission denied") {
        ExtractError::PermissionDenied(msg)
    } else if lower.contains("statement timeout") || lower.contains("canceling statement") {
        ExtractError::Timeout
    } else {
        ExtractError::Other(msg)
    }
}

fn build_schema_model(
    rows: Vec<PgRow>,
    connection_id: &str,
) -> Result<SchemaModel, ExtractError> {
    let mut by_table: BTreeMap<(String, String), TableBuilder> = BTreeMap::new();

    for row in rows {
        let table_schema: String = get_field(&row, "table_schema")?;
        let table_name: String = get_field(&row, "table_name")?;
        let column_name: String = get_field(&row, "column_name")?;
        let data_type: String = get_field(&row, "data_type")?;
        let is_nullable: String = get_field(&row, "is_nullable")?;
        let column_default: Option<String> = get_field(&row, "column_default")?;
        let is_primary_key: bool = get_field(&row, "is_primary_key")?;
        let foreign_table_schema: Option<String> = get_field(&row, "foreign_table_schema")?;
        let foreign_table_name: Option<String> = get_field(&row, "foreign_table_name")?;
        let foreign_column_name: Option<String> = get_field(&row, "foreign_column_name")?;

        let entry = by_table
            .entry((table_schema, table_name))
            .or_insert_with(TableBuilder::default);

        entry.columns.push(Column {
            name: column_name.clone(),
            data_type,
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            default: column_default,
            user_annotation: None,
            sensitive: false,
        });

        if is_primary_key {
            entry.primary_key.push(column_name.clone());
        }

        if let (Some(fs), Some(ft), Some(fc)) =
            (foreign_table_schema, foreign_table_name, foreign_column_name)
        {
            entry.foreign_keys.push(ForeignKey {
                columns: vec![column_name],
                references_schema: fs,
                references_table: ft,
                references_columns: vec![fc],
            });
        }
    }

    let mut by_schema: BTreeMap<String, Vec<Table>> = BTreeMap::new();
    for ((schema_name, table_name), tb) in by_table {
        by_schema.entry(schema_name).or_default().push(Table {
            name: table_name,
            columns: tb.columns,
            primary_key: tb.primary_key,
            foreign_keys: tb.foreign_keys,
            user_annotation: None,
            excluded: false,
        });
    }

    let schemas: Vec<DbSchema> = by_schema
        .into_iter()
        .map(|(name, tables)| DbSchema { name, tables })
        .collect();

    Ok(SchemaModel {
        dialect: Dialect::Postgres,
        schemas,
        extracted_at: time::OffsetDateTime::now_utc().unix_timestamp(),
        source: ExtractionSource::Live {
            connection_id: connection_id.to_string(),
        },
    })
}

fn get_field<'r, T>(row: &'r PgRow, name: &str) -> Result<T, ExtractError>
where
    T: sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get(name)
        .map_err(|e| ExtractError::Other(format!("could not read column {name}: {e}")))
}

#[derive(Default)]
struct TableBuilder {
    columns: Vec<Column>,
    primary_key: Vec<String>,
    foreign_keys: Vec<ForeignKey>,
}
