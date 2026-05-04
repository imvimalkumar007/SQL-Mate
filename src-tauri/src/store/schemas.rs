use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Store, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSchema {
    pub connection_id: String,
    pub extracted_at: i64,
    pub model_json: String,
}

impl Store {
    /// Insert or replace the latest schema for a connection.
    pub fn put_schema(&self, connection_id: &str, model_json: &str) -> Result<(), StoreError> {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO schemas (connection_id, extracted_at, model_json) VALUES (?1, ?2, ?3)
             ON CONFLICT(connection_id) DO UPDATE SET
               extracted_at = excluded.extracted_at,
               model_json = excluded.model_json",
            params![connection_id, now, model_json],
        )?;
        Ok(())
    }

    pub fn get_schema(
        &self,
        connection_id: &str,
    ) -> Result<Option<PersistedSchema>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT connection_id, extracted_at, model_json FROM schemas WHERE connection_id = ?1",
        )?;
        let mut rows = stmt.query(params![connection_id])?;
        match rows.next()? {
            Some(row) => Ok(Some(PersistedSchema {
                connection_id: row.get(0)?,
                extracted_at: row.get(1)?,
                model_json: row.get(2)?,
            })),
            None => Ok(None),
        }
    }
}
