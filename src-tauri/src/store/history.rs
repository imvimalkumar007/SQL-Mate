// history table CRUD. Wires up the dead code path flagged as bug #3 in BUGS.md.
//
// One row is appended per generated question by `generate_sql` and updated by
// `validate_sql` and `execute_query` if they receive the same history_id. The
// table is intentionally append-only from the user's perspective; rows are
// only removed via `clear_history`.

use rusqlite::params;
use serde::Serialize;
use uuid::Uuid;

use super::{Store, StoreError};

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub id:                    String,
    pub connection_id:         String,
    pub asked_at:              i64,
    pub question:              String,
    pub generated_sql:         Option<String>,
    pub validation_status:     String,
    pub validation_error:      Option<String>,
    pub was_executed:          bool,
    pub execution_row_count:   Option<i64>,
    pub execution_duration_ms: Option<i64>,
}

impl Store {
    /// Append a new history row at generation time. Returns the assigned id so
    /// downstream `validate_sql` / `execute_query` can update the same row.
    pub fn record_history(
        &self,
        connection_id: &str,
        question: &str,
        generated_sql: Option<&str>,
    ) -> Result<String, StoreError> {
        let id = Uuid::new_v4().to_string();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO history (id, connection_id, asked_at, question,
                generated_sql, validation_status, validation_error,
                was_executed, execution_row_count, execution_duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 'generated', NULL, 0, NULL, NULL)",
            params![id, connection_id, now, question, generated_sql],
        )?;
        Ok(id)
    }

    pub fn update_history_validation(
        &self,
        history_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), StoreError> {
        let conn = self.lock();
        conn.execute(
            "UPDATE history SET validation_status = ?1, validation_error = ?2 WHERE id = ?3",
            params![status, error, history_id],
        )?;
        Ok(())
    }

    pub fn list_history(
        &self,
        connection_id: &str,
        limit: i64,
    ) -> Result<Vec<HistoryEntry>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, asked_at, question, generated_sql,
                validation_status, validation_error, was_executed,
                execution_row_count, execution_duration_ms
             FROM history WHERE connection_id = ?1
             ORDER BY asked_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![connection_id, limit], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                asked_at: row.get(2)?,
                question: row.get(3)?,
                generated_sql: row.get(4)?,
                validation_status: row.get(5)?,
                validation_error: row.get(6)?,
                was_executed: row.get::<_, i64>(7)? != 0,
                execution_row_count: row.get(8)?,
                execution_duration_ms: row.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn clear_history(&self, connection_id: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM history WHERE connection_id = ?1",
            params![connection_id],
        )?;
        Ok(())
    }
}
