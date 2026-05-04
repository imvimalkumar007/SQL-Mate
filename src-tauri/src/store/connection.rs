use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

const KEYCHAIN_SERVICE: &str = "sql-mate";
const KEYCHAIN_DB_KEY_USER: &str = "db-key";

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
    Keychain(String),
    InvalidKey,
    Migration(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "I/O error: {e}"),
            StoreError::Sqlite(e) => write!(f, "Local store error: {e}"),
            StoreError::Keychain(e) => write!(f, "Keychain error: {e}"),
            StoreError::InvalidKey => write!(
                f,
                "Local store key is invalid. The store file may be corrupted, or the keychain entry may have been wiped."
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

impl From<keyring::Error> for StoreError {
    fn from(e: keyring::Error) -> Self {
        StoreError::Keychain(e.to_string())
    }
}

impl Store {
    /// Open (or create) the local store at `db_path`.
    ///
    /// On the first ever call on this machine, generates 32 random bytes from the
    /// OS CSPRNG and stores them in the OS keychain at the entry
    /// `(service="sql-mate", user="db-key")`. On subsequent calls, reads the key
    /// from the keychain. SQLCipher decrypts the database with this key. If the
    /// keychain entry is missing on a subsequent call, the database is unreadable
    /// and `InvalidKey` is returned — there is no recovery by design (per
    /// `docs/architecture/schema-store.md`).
    pub fn open(db_path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let key = load_or_create_db_key()?;
        let conn = Connection::open(db_path)?;
        let key_pragma = format!("x'{}'", hex_encode(&key));
        conn.pragma_update(None, "key", key_pragma)?;

        // SQLCipher applies the key lazily; the first read against the encrypted
        // pages is what actually fails on a wrong key. SELECT off sqlite_master
        // forces that read.
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

fn load_or_create_db_key() -> Result<[u8; 32], StoreError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_DB_KEY_USER)?;
    match entry.get_password() {
        Ok(hex) => {
            let bytes = hex_decode(&hex).ok_or(StoreError::InvalidKey)?;
            if bytes.len() != 32 {
                return Err(StoreError::InvalidKey);
            }
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            Ok(out)
        }
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|e| StoreError::Keychain(format!("CSPRNG failed: {e}")))?;
            entry.set_password(&hex_encode(&bytes))?;
            Ok(bytes)
        }
        Err(e) => Err(StoreError::from(e)),
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

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
