use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Store, StoreError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub dialect: String,
    pub host: String,
    pub port: u16,
    pub database_name: String,
    pub username: String,
    // Stored within the SQLCipher-encrypted local store. Not exposed back to
    // the frontend.
    #[serde(skip_serializing)]
    pub password: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewConnectionProfile {
    pub name: String,
    pub dialect: String,
    pub host: String,
    pub port: u16,
    pub database_name: String,
    pub username: String,
    pub password: String,
}

impl Store {
    pub fn create_profile(
        &self,
        new: NewConnectionProfile,
    ) -> Result<ConnectionProfile, StoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = time::OffsetDateTime::now_utc().unix_timestamp();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO connection_profiles
                (id, name, dialect, host, port, database_name, username, password, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                new.name,
                new.dialect,
                new.host,
                new.port,
                new.database_name,
                new.username,
                new.password,
                created_at,
            ],
        )?;
        Ok(ConnectionProfile {
            id,
            name: new.name,
            dialect: new.dialect,
            host: new.host,
            port: new.port,
            database_name: new.database_name,
            username: new.username,
            password: new.password,
            created_at,
            last_used_at: None,
        })
    }

    pub fn list_profiles(&self) -> Result<Vec<ConnectionProfile>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, dialect, host, port, database_name, username, password, created_at, last_used_at
             FROM connection_profiles ORDER BY name",
        )?;
        let rows = stmt.query_map([], row_to_profile)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn get_profile(&self, id: &str) -> Result<Option<ConnectionProfile>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, dialect, host, port, database_name, username, password, created_at, last_used_at
             FROM connection_profiles WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => row_to_profile(row).map(Some).map_err(StoreError::from),
            None => Ok(None),
        }
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM connection_profiles WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn touch_profile(&self, id: &str) -> Result<(), StoreError> {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let conn = self.lock();
        conn.execute(
            "UPDATE connection_profiles SET last_used_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }
}

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionProfile> {
    Ok(ConnectionProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        dialect: row.get(2)?,
        host: row.get(3)?,
        port: row.get::<_, i64>(4)? as u16,
        database_name: row.get(5)?,
        username: row.get(6)?,
        password: row.get(7)?,
        created_at: row.get(8)?,
        last_used_at: row.get(9)?,
    })
}
