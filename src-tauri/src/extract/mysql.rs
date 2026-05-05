// MySQL / MariaDB schema extractor. See ADR 0012.
//
// Mirrors the Postgres extractor but uses sqlx's mysql connection type and
// the dialect-specific extraction query from
// `docs/architecture/schema-extraction.md`.

use std::collections::BTreeMap;

use sqlx::mysql::{MySqlConnectOptions, MySqlRow};
use sqlx::{ConnectOptions, Connection, Row};

use crate::schema::{
    Column, DbSchema, Dialect, ExtractionSource, ForeignKey, SchemaModel, Table,
};

use super::ExtractError;

const EXTRACTION_QUERY: &str = r#"
SELECT
  c.TABLE_SCHEMA AS table_schema,
  c.TABLE_NAME AS table_name,
  c.COLUMN_NAME AS column_name,
  c.ORDINAL_POSITION AS ordinal_position,
  c.DATA_TYPE AS data_type,
  c.IS_NULLABLE AS is_nullable,
  c.COLUMN_DEFAULT AS column_default,
  CASE WHEN c.COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END AS is_primary_key,
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
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
"#;

#[derive(Debug, Clone)]
pub struct MySqlConnectionParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

impl MySqlConnectionParams {
    fn into_options(self) -> MySqlConnectOptions {
        MySqlConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .database(&self.database)
            .username(&self.username)
            .password(&self.password)
    }
}

pub async fn test_connection(params: MySqlConnectionParams) -> Result<(), ExtractError> {
    let mut conn = params
        .into_options()
        .connect()
        .await
        .map_err(super::classify_connect_error)?;
    sqlx::query("SELECT 1")
        .execute(&mut conn)
        .await
        .map_err(super::classify_query_error)?;
    let _ = conn.close().await;
    Ok(())
}

pub async fn extract_schema(
    params: MySqlConnectionParams,
    connection_id: &str,
) -> Result<SchemaModel, ExtractError> {
    let mut conn = params
        .into_options()
        .connect()
        .await
        .map_err(super::classify_connect_error)?;

    // Defense in depth on top of the user-configured read-only role.
    // MySQL 5.6+ supports `SET SESSION TRANSACTION READ ONLY` per-connection;
    // we set it on the session for any subsequent BEGIN.
    sqlx::query("SET SESSION TRANSACTION READ ONLY")
        .execute(&mut conn)
        .await
        .map_err(super::classify_query_error)?;

    let rows: Vec<MySqlRow> = sqlx::query(EXTRACTION_QUERY)
        .fetch_all(&mut conn)
        .await
        .map_err(super::classify_query_error)?;

    let _ = conn.close().await;

    if rows.is_empty() {
        return Err(ExtractError::EmptyResult);
    }

    build_schema_model(rows, connection_id)
}

fn build_schema_model(
    rows: Vec<MySqlRow>,
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
        let is_primary_key_int: i64 = get_field(&row, "is_primary_key")?;
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

        if is_primary_key_int != 0 {
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
        dialect: Dialect::MySql,
        schemas,
        extracted_at: time::OffsetDateTime::now_utc().unix_timestamp(),
        source: ExtractionSource::Live {
            connection_id: connection_id.to_string(),
        },
    })
}

fn get_field<'r, T>(row: &'r MySqlRow, name: &str) -> Result<T, ExtractError>
where
    T: sqlx::Decode<'r, sqlx::MySql> + sqlx::Type<sqlx::MySql>,
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
