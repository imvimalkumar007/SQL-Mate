use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

const MIGRATIONS: &[(u32, &str)] = &[(
    1,
    include_str!("../../migrations/0001_initial_schema.sql"),
)];

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Debug)]
pub enum StoreError {
    Io(String),
    Sqlite(String),
    InvalidKey,
    Migration(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "I/O error: {e}"),
            StoreError::Sqlite(e) => write!(f, "Local store error: {e}"),
            StoreError::InvalidKey => write!(
                f,
                "Local store key is invalid. The store file may be corrupted, or the key file may have been deleted."
            ),
            StoreError::Migration(e) => write!(f, "Migration error: {e}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e.to_string())
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e.to_string())
    }
}

impl Store {
    /// Open (or create) the local store at `db_path`.
    ///
    /// SQLCipher key is loaded from a file next to `db_path` named `.db-key`.
    /// On first launch the file is created with 32 random bytes from the OS
    /// CSPRNG. The file is the keychain's stand-in until Phase 7 revisits
    /// keychain integration (`keyring::set_password` silently no-ops on
    /// Windows 10.0.26200 — tracked in PHASE_2_LOG.md).
    pub fn open(db_path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let key_path = db_path.with_file_name(".db-key");
        let key = load_or_create_db_key(&key_path)?;

        let conn = Connection::open(db_path)?;
        let key_pragma = format!("x'{}'", hex_encode(&key));
        conn.pragma_update(None, "key", key_pragma)?;

        match conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        }) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(_, _)) => return Err(StoreError::InvalidKey),
            Err(e) => return Err(StoreError::Sqlite(e.to_string())),
        }

        run_migrations(&conn)?;

        Ok(Store {
            conn: Mutex::new(conn),
        })
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("store mutex poisoned")
    }
}

fn load_or_create_db_key(key_path: &Path) -> Result<[u8; 32], StoreError> {
    if key_path.exists() {
        let bytes = std::fs::read(key_path)?;
        if bytes.len() != 32 {
            return Err(StoreError::InvalidKey);
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Ok(out)
    } else {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|e| StoreError::Io(format!("CSPRNG failed: {e}")))?;
        std::fs::write(key_path, bytes)?;
        Ok(bytes)
    }
}

fn run_migrations(conn: &Connection) -> Result<(), StoreError> {
    let current: u32 = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    for &(version, sql) in MIGRATIONS {
        if version > current {
            conn.execute_batch(sql)
                .map_err(|e| StoreError::Migration(e.to_string()))?;
        }
    }
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}
