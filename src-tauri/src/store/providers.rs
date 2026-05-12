// Provider configuration CRUD on the SQLCipher-encrypted store.
// See ADR 0010 and migration 0002_provider_configs.sql.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Store, StoreError};

#[rustfmt::skip]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id:         String,
    pub name:       String,
    pub kind:       String, // "anthropic" | "openai" | "openai_compatible"
    pub base_url:   String,
    pub model:      String,
    // api_key never reaches the frontend.
    #[serde(skip_serializing)]
    pub api_key:    String,
    pub created_at: i64,
}

#[rustfmt::skip]
#[derive(Debug, Clone, Deserialize)]
pub struct NewProviderConfig {
    pub name:     String,
    pub kind:     String,
    pub base_url: String,
    pub model:    String,
    pub api_key:  String,
}

impl Store {
    pub fn create_provider_config(
        &self,
        new: NewProviderConfig,
    ) -> Result<ProviderConfig, StoreError> {
        if !["anthropic", "openai", "openai_compatible"].contains(&new.kind.as_str()) {
            return Err(StoreError::Sqlite(format!(
                "unknown provider kind: {}",
                new.kind
            )));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = time::OffsetDateTime::now_utc().unix_timestamp();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO provider_configs (id, name, kind, base_url, model, api_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                new.name,
                new.kind,
                new.base_url,
                new.model,
                new.api_key,
                created_at
            ],
        )?;
        Ok(ProviderConfig {
            id,
            name: new.name,
            kind: new.kind,
            base_url: new.base_url,
            model: new.model,
            api_key: new.api_key,
            created_at,
        })
    }

    pub fn list_provider_configs(&self) -> Result<Vec<ProviderConfig>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, base_url, model, api_key, created_at
             FROM provider_configs ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], row_to_provider)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_provider_config(&self, id: &str) -> Result<Option<ProviderConfig>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, kind, base_url, model, api_key, created_at
             FROM provider_configs WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => row_to_provider(row).map(Some).map_err(StoreError::from),
            None => Ok(None),
        }
    }

    pub fn delete_provider_config(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM provider_configs WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Update only the model identifier on an existing provider config. Used
    /// by the Phase 7 picker for in-flow model switching without rotating the
    /// stored API key.
    pub fn update_provider_model(&self, id: &str, model: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE provider_configs SET model = ?1 WHERE id = ?2",
            params![model, id],
        )?;
        if n == 0 {
            return Err(StoreError::Sqlite(format!(
                "provider config {id} not found"
            )));
        }
        Ok(())
    }
}

fn row_to_provider(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderConfig> {
    Ok(ProviderConfig {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        base_url: row.get(3)?,
        model: row.get(4)?,
        api_key: row.get(5)?,
        created_at: row.get(6)?,
    })
}
