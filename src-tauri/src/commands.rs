use rusqlite::params;
use serde::Deserialize;
use tauri::State;

use crate::extract::postgres::{self, PgConnectionParams};
use crate::llm::anthropic;
use crate::schema::SchemaModel;
use crate::store::{ConnectionProfile, NewConnectionProfile, Store, StoreError};

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
