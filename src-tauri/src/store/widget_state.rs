// Phase 10: floating widget state — position, last question, last SQL.
//
// Single-row table (PK = 'singleton'). Persisted via SQLCipher like every
// other piece of user data; no extra encryption surface. Cleared/reset
// when the user clicks "new question" in the widget or after 24 hours of
// inactivity (the latter is enforced at read time).

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Store, StoreError};

const TWENTY_FOUR_HOURS_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetState {
    pub position_x: Option<i32>,
    pub position_y: Option<i32>,
    pub last_question: Option<String>,
    pub last_sql: Option<String>,
    pub last_model: Option<String>,
    pub last_validation_status: Option<String>,
    pub last_validation_error: Option<String>,
    pub pill_mode: bool,
    pub updated_at: i64,
}

impl Default for WidgetState {
    fn default() -> Self {
        Self {
            position_x: None,
            position_y: None,
            last_question: None,
            last_sql: None,
            last_model: None,
            last_validation_status: None,
            last_validation_error: None,
            pill_mode: false,
            updated_at: 0,
        }
    }
}

impl Store {
    /// Read the widget state, with the last_question / last_sql / last_model
    /// fields cleared if more than 24 hours old. Position and pill_mode are
    /// returned regardless of staleness — the user wants the widget to come
    /// back where they left it even after a weekend.
    pub fn get_widget_state(&self) -> Result<WidgetState, StoreError> {
        let conn = self.lock();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let mut stmt = conn.prepare(
            "SELECT position_x, position_y, last_question, last_sql, last_model,
                    last_validation_status, last_validation_error, pill_mode,
                    updated_at
             FROM widget_state WHERE id = 'singleton'",
        )?;
        let mut rows = stmt.query([])?;
        match rows.next()? {
            Some(row) => {
                let updated_at: i64 = row.get(8)?;
                let stale = now - updated_at > TWENTY_FOUR_HOURS_SECONDS;
                Ok(WidgetState {
                    position_x: row.get(0)?,
                    position_y: row.get(1)?,
                    last_question: if stale { None } else { row.get(2)? },
                    last_sql: if stale { None } else { row.get(3)? },
                    last_model: if stale { None } else { row.get(4)? },
                    last_validation_status: if stale { None } else { row.get(5)? },
                    last_validation_error: if stale { None } else { row.get(6)? },
                    pill_mode: row.get::<_, i64>(7)? != 0,
                    updated_at,
                })
            }
            None => Ok(WidgetState::default()),
        }
    }

    pub fn set_widget_position(&self, x: i32, y: i32) -> Result<(), StoreError> {
        let conn = self.lock();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        conn.execute(
            "UPDATE widget_state SET position_x = ?1, position_y = ?2, updated_at = ?3
             WHERE id = 'singleton'",
            params![x, y, now],
        )?;
        Ok(())
    }

    pub fn set_widget_pill_mode(&self, pill_mode: bool) -> Result<(), StoreError> {
        let conn = self.lock();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        conn.execute(
            "UPDATE widget_state SET pill_mode = ?1, updated_at = ?2
             WHERE id = 'singleton'",
            params![if pill_mode { 1 } else { 0 }, now],
        )?;
        Ok(())
    }

    pub fn set_widget_last_query(
        &self,
        question: Option<&str>,
        sql: Option<&str>,
        model: Option<&str>,
        validation_status: Option<&str>,
        validation_error: Option<&str>,
    ) -> Result<(), StoreError> {
        let conn = self.lock();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        conn.execute(
            "UPDATE widget_state SET last_question = ?1, last_sql = ?2,
                    last_model = ?3, last_validation_status = ?4,
                    last_validation_error = ?5, updated_at = ?6
             WHERE id = 'singleton'",
            params![question, sql, model, validation_status, validation_error, now],
        )?;
        Ok(())
    }

    pub fn clear_widget_last_query(&self) -> Result<(), StoreError> {
        self.set_widget_last_query(None, None, None, None, None)
    }
}
