// schema_embeddings table CRUD. See ADR 0011 and migration 0003.

use rusqlite::params;

use super::{Store, StoreError};

#[derive(Debug, Clone)]
pub struct StoredEmbedding {
    pub qualified_table: String,
    pub embedding: Vec<f32>,
    pub model: String,
    pub dimensions: i64,
    pub embedded_at: i64,
}

impl Store {
    pub fn put_embeddings(
        &self,
        connection_id: &str,
        model: &str,
        embeddings: Vec<(String, Vec<f32>)>,
    ) -> Result<(), StoreError> {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let conn = self.lock();
        for (qualified, vec) in embeddings {
            let dimensions = vec.len() as i64;
            let json = serde_json::to_string(&vec)
                .map_err(|e| StoreError::Sqlite(format!("embedding serialize: {e}")))?;
            conn.execute(
                "INSERT INTO schema_embeddings
                    (connection_id, qualified_table, embedding, model, dimensions, embedded_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(connection_id, qualified_table) DO UPDATE SET
                    embedding = excluded.embedding,
                    model = excluded.model,
                    dimensions = excluded.dimensions,
                    embedded_at = excluded.embedded_at",
                params![connection_id, qualified, json, model, dimensions, now],
            )?;
        }
        Ok(())
    }

    pub fn list_embeddings(
        &self,
        connection_id: &str,
    ) -> Result<Vec<StoredEmbedding>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT qualified_table, embedding, model, dimensions, embedded_at
             FROM schema_embeddings WHERE connection_id = ?1",
        )?;
        let rows = stmt.query_map(params![connection_id], |row| {
            let json: String = row.get(1)?;
            Ok((
                row.get::<_, String>(0)?,
                json,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;

        let mut out = Vec::new();
        for r in rows {
            let (qualified, json, model, dimensions, embedded_at) = r?;
            let embedding: Vec<f32> = serde_json::from_str(&json).map_err(|e| {
                StoreError::Sqlite(format!(
                    "embedding parse failed for {qualified}: {e}"
                ))
            })?;
            out.push(StoredEmbedding {
                qualified_table: qualified,
                embedding,
                model,
                dimensions,
                embedded_at,
            });
        }
        Ok(out)
    }

    pub fn count_embeddings(&self, connection_id: &str) -> Result<i64, StoreError> {
        let conn = self.lock();
        let count: i64 = conn.query_row(
            "SELECT count(*) FROM schema_embeddings WHERE connection_id = ?1",
            params![connection_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    pub fn clear_embeddings(&self, connection_id: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM schema_embeddings WHERE connection_id = ?1",
            params![connection_id],
        )?;
        Ok(())
    }
}
