use std::time::Instant;

use futures::stream::StreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgRow};
use sqlx::{Column, ConnectOptions, Connection, Row};
use tauri::State;

use crate::extract::postgres::{self, PgConnectionParams};
use crate::llm::anthropic;
use crate::schema::SchemaModel;
use crate::sidecar::{SidecarManager, ValidatedSql};
use crate::store::{ConnectionProfile, NewConnectionProfile, Store, StoreError};

const ROW_CAP: usize = 1_000;
const QUERY_TIMEOUT_MS: u64 = 30_000;

const SETTING_API_KEY: &str = "anthropic_api_key";

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- Connection profiles ----------

#[derive(Debug, Deserialize)]
pub struct CreateProfileRequest {
    pub name: String,
    pub dialect: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

#[tauri::command]
pub async fn create_connection_profile(
    req: CreateProfileRequest,
    store: State<'_, Store>,
) -> Result<ConnectionProfile, String> {
    store
        .create_profile(NewConnectionProfile {
            name: req.name,
            dialect: req.dialect,
            host: req.host,
            port: req.port,
            database_name: req.database,
            username: req.username,
            password: req.password,
        })
        .map_err(err)
}

#[tauri::command]
pub async fn list_connection_profiles(
    store: State<'_, Store>,
) -> Result<Vec<ConnectionProfile>, String> {
    store.list_profiles().map_err(err)
}

#[tauri::command]
pub async fn delete_connection_profile(
    id: String,
    store: State<'_, Store>,
) -> Result<(), String> {
    store.delete_profile(&id).map_err(err)
}

// ---------- Connection testing + extraction ----------

#[derive(Debug, Deserialize)]
pub struct TestConnectionRequest {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

#[tauri::command]
pub async fn test_connection(req: TestConnectionRequest) -> Result<(), String> {
    postgres::test_connection(PgConnectionParams {
        host: req.host,
        port: req.port,
        database: req.database,
        username: req.username,
        password: req.password,
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn extract_schema(
    connection_id: String,
    store: State<'_, Store>,
) -> Result<SchemaModel, String> {
    let profile = store
        .get_profile(&connection_id)
        .map_err(err)?
        .ok_or_else(|| "connection profile not found".to_string())?;

    let model = postgres::extract_schema(
        PgConnectionParams {
            host: profile.host,
            port: profile.port,
            database: profile.database_name,
            username: profile.username,
            password: profile.password,
        },
        &connection_id,
    )
    .await
    .map_err(err)?;

    let model_json = serde_json::to_string(&model).map_err(err)?;
    store.put_schema(&connection_id, &model_json).map_err(err)?;
    store.touch_profile(&connection_id).map_err(err)?;

    Ok(model)
}

#[tauri::command]
pub async fn get_persisted_schema(
    connection_id: String,
    store: State<'_, Store>,
) -> Result<Option<SchemaModel>, String> {
    match store.get_schema(&connection_id).map_err(err)? {
        Some(p) => {
            let model: SchemaModel = serde_json::from_str(&p.model_json).map_err(err)?;
            Ok(Some(model))
        }
        None => Ok(None),
    }
}

// ---------- API key (stored in settings table) ----------

fn settings_get(store: &Store, key: &str) -> Result<Option<String>, StoreError> {
    let conn = store.lock();
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

fn settings_set(store: &Store, key: &str, value: &str) -> Result<(), StoreError> {
    let conn = store.lock();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn settings_delete(store: &Store, key: &str) -> Result<(), StoreError> {
    let conn = store.lock();
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

#[tauri::command]
pub async fn save_api_key(api_key: String, store: State<'_, Store>) -> Result<(), String> {
    settings_set(&store, SETTING_API_KEY, &api_key).map_err(err)
}

#[tauri::command]
pub async fn delete_api_key(store: State<'_, Store>) -> Result<(), String> {
    settings_delete(&store, SETTING_API_KEY).map_err(err)
}

#[tauri::command]
pub async fn has_api_key(store: State<'_, Store>) -> Result<bool, String> {
    Ok(settings_get(&store, SETTING_API_KEY).map_err(err)?.is_some())
}

// ---------- SQL generation against the persisted schema ----------

#[tauri::command]
pub async fn generate_sql(
    connection_id: String,
    question: String,
    store: State<'_, Store>,
) -> Result<String, String> {
    let api_key = settings_get(&store, SETTING_API_KEY).map_err(err)?.ok_or_else(|| {
        "No Anthropic API key saved. Add one in settings before generating.".to_string()
    })?;

    let persisted = store
        .get_schema(&connection_id)
        .map_err(err)?
        .ok_or_else(|| {
            "No schema extracted yet for this connection. Click \"Extract schema\" first."
                .to_string()
        })?;
    let model: SchemaModel = serde_json::from_str(&persisted.model_json).map_err(err)?;

    let schema_text = format_schema_for_prompt(&model);

    anthropic::call_anthropic(&api_key, &schema_text, &question)
        .await
        .map_err(err)
}

// ---------- Validation ----------

#[tauri::command]
pub async fn validate_sql(
    connection_id: String,
    sql: String,
    store: State<'_, Store>,
    sidecar: State<'_, SidecarManager>,
) -> Result<ValidatedSql, String> {
    layer1_prevalidate(&sql).map_err(|m| m.to_string())?;

    let persisted = store
        .get_schema(&connection_id)
        .map_err(err)?
        .ok_or_else(|| {
            "No schema extracted for this connection. Click \"Extract schema\" first."
                .to_string()
        })?;
    let schema_value: Value = serde_json::from_str(&persisted.model_json).map_err(err)?;

    sidecar
        .validate("postgres", &sql, schema_value)
        .await
        .map_err(err)
}

/// Cheap Rust-side syntactic check that rejects obvious mutating queries
/// before invoking the sidecar. Per docs/architecture/sql-validation.md.
fn layer1_prevalidate(sql: &str) -> Result<(), &'static str> {
    let upper = sql.to_uppercase();
    let head = upper.trim_start();
    if head.is_empty() {
        return Err("query is empty");
    }
    let starts_with = |kw: &str| head.starts_with(kw)
        && head.as_bytes().get(kw.len()).map_or(true, |b| !b.is_ascii_alphanumeric() && *b != b'_');
    if !starts_with("SELECT") && !starts_with("WITH") {
        return Err("query must start with SELECT or WITH");
    }
    let forbidden = [
        "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "CREATE",
        "GRANT", "REVOKE", "EXECUTE", "EXEC", "CALL", "MERGE", "LOCK",
        "RENAME", "COMMENT", "COPY", "LOAD", "IMPORT", "EXPORT", "BACKUP", "RESTORE",
    ];
    for token in upper.split(|c: char| !c.is_ascii_alphabetic()) {
        if forbidden.contains(&token) {
            return Err("query contains a forbidden mutating keyword");
        }
    }
    Ok(())
}

// ---------- Execution ----------

#[derive(Debug, Serialize)]
pub struct ExecutionResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    store: State<'_, Store>,
    sidecar: State<'_, SidecarManager>,
) -> Result<ExecutionResult, String> {
    // Re-validate before executing — defense in depth in case the UI sends a
    // query whose validation has expired (schema re-extracted) or that was
    // edited between validate and run.
    layer1_prevalidate(&sql).map_err(|m| m.to_string())?;
    let persisted = store
        .get_schema(&connection_id)
        .map_err(err)?
        .ok_or_else(|| "No schema extracted for this connection.".to_string())?;
    let schema_value: Value = serde_json::from_str(&persisted.model_json).map_err(err)?;
    let validated = sidecar
        .validate("postgres", &sql, schema_value)
        .await
        .map_err(err)?;

    let profile = store
        .get_profile(&connection_id)
        .map_err(err)?
        .ok_or_else(|| "connection profile not found".to_string())?;

    let opts = PgConnectOptions::new()
        .host(&profile.host)
        .port(profile.port)
        .database(&profile.database_name)
        .username(&profile.username)
        .password(&profile.password);

    let mut conn = opts.connect().await.map_err(err)?;

    // Defense in depth on top of the read-only DB role.
    sqlx::query("SET default_transaction_read_only = on")
        .execute(&mut conn)
        .await
        .map_err(err)?;
    sqlx::query(&format!("SET statement_timeout = {QUERY_TIMEOUT_MS}"))
        .execute(&mut conn)
        .await
        .map_err(err)?;

    let start = Instant::now();
    let mut stream = sqlx::query(&validated.sql).fetch(&mut conn);
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut columns: Vec<String> = Vec::new();
    let mut truncated = false;

    while let Some(row_result) = stream.next().await {
        if rows.len() >= ROW_CAP {
            truncated = true;
            break;
        }
        let row: PgRow = row_result.map_err(err)?;
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        let mut json_row = Vec::with_capacity(row.columns().len());
        for i in 0..row.columns().len() {
            json_row.push(decode_value(&row, i));
        }
        rows.push(json_row);
    }
    drop(stream);
    let duration = start.elapsed();
    let _ = conn.close().await;

    let _ = validated; // silence unused-result warning

    Ok(ExecutionResult {
        row_count: rows.len(),
        columns,
        rows,
        truncated,
        duration_ms: duration.as_millis() as u64,
    })
}

/// Best-effort generic decoder. Tries common Postgres types in order. For
/// types we don't decode (e.g. timestamps without the sqlx `time` feature),
/// falls back to a placeholder string. Phase 3 walking skeleton — Phase 5
/// or later should harden this.
fn decode_value(row: &PgRow, i: usize) -> Value {
    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
        return v.map(Value::from).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
        return v.map(|x| Value::from(x as i64)).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
        return v.map(Value::from).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
        return v
            .and_then(|x| serde_json::Number::from_f64(x).map(Value::from))
            .unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
        return v
            .and_then(|x| serde_json::Number::from_f64(x as f64).map(Value::from))
            .unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return v.map(Value::from).unwrap_or(Value::Null);
    }
    let type_name = row
        .columns()
        .get(i)
        .map(|c| c.type_info().to_string())
        .unwrap_or_else(|| "?".into());
    Value::String(format!("<unsupported type: {type_name}>"))
}

fn format_schema_for_prompt(model: &SchemaModel) -> String {
    let mut out = String::new();
    for db_schema in &model.schemas {
        out.push_str("schema: ");
        out.push_str(&db_schema.name);
        out.push('\n');
        for table in &db_schema.tables {
            if table.excluded {
                continue;
            }
            out.push_str("  ");
            out.push_str(&table.name);
            if let Some(annot) = &table.user_annotation {
                out.push_str("  -- ");
                out.push_str(annot);
            }
            out.push('\n');
            for col in &table.columns {
                out.push_str("    ");
                out.push_str(&col.name);
                out.push_str(": ");
                out.push_str(&col.data_type);
                if table.primary_key.contains(&col.name) {
                    out.push_str(" [PK]");
                }
                if !col.nullable {
                    out.push_str(" [NOT NULL]");
                }
                for fk in &table.foreign_keys {
                    if fk.columns.contains(&col.name) {
                        out.push_str(&format!(
                            " [FK -> {}.{}.{}]",
                            fk.references_schema,
                            fk.references_table,
                            fk.references_columns.join(",")
                        ));
                    }
                }
                if let Some(annot) = &col.user_annotation {
                    out.push_str("  -- ");
                    out.push_str(annot);
                }
                out.push('\n');
            }
        }
    }
    out
}
