use rusqlite::params;
use serde::Serialize;

use super::{Store, StoreError};

#[derive(Debug, Clone, Serialize)]
pub struct PersistedRequestLogEntry {
    pub id: i64,
    pub connection_id: String,
    pub timestamp: i64,
    pub model: String,
    pub provider_kind: String,
    pub system_prompt: String,
    pub user_message: String,
    pub obfuscated_columns: i64,
    pub excluded_tables: Vec<String>,
}

impl Store {
    pub fn persist_request_log_entry(
        &self,
        connection_id: &str,
        timestamp: i64,
        model: &str,
        provider_kind: &str,
        system_prompt: &str,
        user_message: &str,
        obfuscated_columns: usize,
        excluded_tables: &[String],
    ) -> Result<i64, StoreError> {
        let excluded_json =
            serde_json::to_string(excluded_tables).unwrap_or_else(|_| "[]".to_string());
        let conn = self.lock();
        conn.execute(
            "INSERT INTO request_log
                (connection_id, timestamp, model, provider_kind,
                 system_prompt, user_message, obfuscated_columns, excluded_tables)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                connection_id,
                timestamp,
                model,
                provider_kind,
                system_prompt,
                user_message,
                obfuscated_columns as i64,
                excluded_json,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_request_log(
        &self,
        connection_id: &str,
        limit: i64,
    ) -> Result<Vec<PersistedRequestLogEntry>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, timestamp, model, provider_kind,
                    system_prompt, user_message, obfuscated_columns, excluded_tables
             FROM request_log
             WHERE connection_id = ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![connection_id, limit], row_to_entry)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn list_all_request_log(&self) -> Result<Vec<PersistedRequestLogEntry>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, timestamp, model, provider_kind,
                    system_prompt, user_message, obfuscated_columns, excluded_tables
             FROM request_log
             ORDER BY timestamp DESC",
        )?;
        let rows = stmt.query_map([], row_to_entry)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn clear_request_log(&self, connection_id: &str) -> Result<usize, StoreError> {
        let conn = self.lock();
        let n = conn.execute(
            "DELETE FROM request_log WHERE connection_id = ?1",
            params![connection_id],
        )?;
        Ok(n)
    }
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersistedRequestLogEntry> {
    let excluded_json: String = row.get(8)?;
    let excluded_tables: Vec<String> =
        serde_json::from_str(&excluded_json).unwrap_or_default();
    Ok(PersistedRequestLogEntry {
        id: row.get(0)?,
        connection_id: row.get(1)?,
        timestamp: row.get(2)?,
        model: row.get(3)?,
        provider_kind: row.get(4)?,
        system_prompt: row.get(5)?,
        user_message: row.get(6)?,
        obfuscated_columns: row.get(7)?,
        excluded_tables,
    })
}
