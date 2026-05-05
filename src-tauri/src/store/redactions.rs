// CRUD for the `annotations` and `redactions` tables. Both tables already
// exist from migration 0001 and have been dormant through Phases 2-7;
// Phase 8 wires them up.
//
// Storage convention: column_name is `''` (empty string) — never NULL — when
// the row applies to the whole table. This is because SQLite treats NULL
// values as distinct in unique indexes, which would let multiple
// "table-level" rows coexist for the same (connection, schema, table) and
// break our INSERT OR REPLACE semantics. Empty string compares equal, so
// the PK uniqueness works as intended. The application boundary maps
// Option<String>::None ↔ "" on the way in/out.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Store, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub connection_id: String,
    pub schema_name: String,
    pub table_name: String,
    /// `None` = this annotation applies to the whole table.
    pub column_name: Option<String>,
    pub annotation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Redaction {
    pub connection_id: String,
    pub schema_name: String,
    pub table_name: String,
    /// `None` = the redaction applies at the table level (`kind = "excluded"`).
    /// `Some(_)` = the redaction applies to a specific column
    /// (`kind = "sensitive"`).
    pub column_name: Option<String>,
    /// `"excluded"` or `"sensitive"`. v1 uses the convention that excluded is
    /// table-level and sensitive is column-level; the schema CHECK constraint
    /// allows either combination but the app does not.
    pub kind: String,
}

fn col_from_db(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

impl Store {
    // ----- annotations -----

    /// Upsert an annotation. `column_name = None` is a table-level annotation.
    pub fn set_annotation(
        &self,
        connection_id: &str,
        schema_name: &str,
        table_name: &str,
        column_name: Option<&str>,
        annotation: &str,
    ) -> Result<(), StoreError> {
        let col = column_name.unwrap_or("");
        let conn = self.lock();
        conn.execute(
            "INSERT INTO annotations (connection_id, schema_name, table_name, column_name, annotation)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(connection_id, schema_name, table_name, column_name)
             DO UPDATE SET annotation = excluded.annotation",
            params![connection_id, schema_name, table_name, col, annotation],
        )?;
        Ok(())
    }

    pub fn clear_annotation(
        &self,
        connection_id: &str,
        schema_name: &str,
        table_name: &str,
        column_name: Option<&str>,
    ) -> Result<(), StoreError> {
        let col = column_name.unwrap_or("");
        let conn = self.lock();
        conn.execute(
            "DELETE FROM annotations
             WHERE connection_id = ?1 AND schema_name = ?2
               AND table_name = ?3 AND column_name = ?4",
            params![connection_id, schema_name, table_name, col],
        )?;
        Ok(())
    }

    pub fn list_annotations(
        &self,
        connection_id: &str,
    ) -> Result<Vec<Annotation>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT connection_id, schema_name, table_name, column_name, annotation
             FROM annotations WHERE connection_id = ?1",
        )?;
        let rows = stmt.query_map(params![connection_id], |row| {
            Ok(Annotation {
                connection_id: row.get(0)?,
                schema_name: row.get(1)?,
                table_name: row.get(2)?,
                column_name: col_from_db(row.get::<_, String>(3)?),
                annotation: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ----- redactions -----

    /// Upsert a redaction. Validates that the (kind, column_name) pair matches
    /// the v1 application convention: excluded → no column, sensitive → has
    /// column. Returns an error otherwise so the UI can't construct a state
    /// that the overlay code wouldn't know how to apply.
    pub fn set_redaction(
        &self,
        connection_id: &str,
        schema_name: &str,
        table_name: &str,
        column_name: Option<&str>,
        kind: &str,
    ) -> Result<(), StoreError> {
        match (kind, column_name) {
            ("excluded", None) => {}
            ("sensitive", Some(_)) => {}
            ("excluded", Some(_)) => {
                return Err(StoreError::Sqlite(
                    "v1: 'excluded' applies to whole tables only — pass column_name = None"
                        .into(),
                ));
            }
            ("sensitive", None) => {
                return Err(StoreError::Sqlite(
                    "v1: 'sensitive' applies to columns only — pass a column_name".into(),
                ));
            }
            (other, _) => {
                return Err(StoreError::Sqlite(format!(
                    "unknown redaction kind: {other}"
                )));
            }
        }

        let col = column_name.unwrap_or("");
        let conn = self.lock();
        conn.execute(
            "INSERT INTO redactions (connection_id, schema_name, table_name, column_name, kind)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(connection_id, schema_name, table_name, column_name)
             DO UPDATE SET kind = excluded.kind",
            params![connection_id, schema_name, table_name, col, kind],
        )?;
        Ok(())
    }

    pub fn clear_redaction(
        &self,
        connection_id: &str,
        schema_name: &str,
        table_name: &str,
        column_name: Option<&str>,
    ) -> Result<(), StoreError> {
        let col = column_name.unwrap_or("");
        let conn = self.lock();
        conn.execute(
            "DELETE FROM redactions
             WHERE connection_id = ?1 AND schema_name = ?2
               AND table_name = ?3 AND column_name = ?4",
            params![connection_id, schema_name, table_name, col],
        )?;
        Ok(())
    }

    pub fn list_redactions(
        &self,
        connection_id: &str,
    ) -> Result<Vec<Redaction>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT connection_id, schema_name, table_name, column_name, kind
             FROM redactions WHERE connection_id = ?1",
        )?;
        let rows = stmt.query_map(params![connection_id], |row| {
            Ok(Redaction {
                connection_id: row.get(0)?,
                schema_name: row.get(1)?,
                table_name: row.get(2)?,
                column_name: col_from_db(row.get::<_, String>(3)?),
                kind: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}
