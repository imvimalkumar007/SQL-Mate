use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use zeroize::Zeroizing;

// getrandom is used both in load_or_create_db_key (first launch) and in
// rotate_db_key (re-key operation).
use getrandom::fill as csprng_fill;

const MIGRATIONS: &[(u32, &str)] = &[
    (1, include_str!("../../migrations/0001_initial_schema.sql")),
    (2, include_str!("../../migrations/0002_provider_configs.sql")),
    (3, include_str!("../../migrations/0003_schema_embeddings.sql")),
    (4, include_str!("../../migrations/0004_widget_state.sql")),
];

pub struct Store {
    conn: Mutex<Connection>,
    /// Path to the `.db-key` file — kept so `rotate_db_key` can update it
    /// without needing the caller to pass it again.
    key_path: std::path::PathBuf,
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

        // Build the key pragma as a Zeroizing string so the hex key material
        // is zeroed from memory when this local is dropped.
        let key_hex = Zeroizing::new(hex_encode(&*key));
        let key_pragma = Zeroizing::new(format!("x'{}'", *key_hex));
        conn.pragma_update(None, "key", key_pragma.as_str())?;

        // Instruct SQLCipher to zero page memory before returning pages to
        // the pool. Small performance cost; significant for security.
        conn.pragma_update(None, "cipher_memory_security", "ON")?;

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
            key_path: key_path.to_path_buf(),
        })
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("store mutex poisoned")
    }

    /// Generate a new 32-byte random key, apply it to the open SQLCipher
    /// database via `PRAGMA rekey`, and overwrite the `.db-key` file.
    ///
    /// The operation is best-effort atomic: if writing the file fails after
    /// `PRAGMA rekey` succeeds, the database is already re-encrypted with the
    /// new key and the old key file is now stale. The error is surfaced so the
    /// caller can warn the user to restart the app (which will surface
    /// `StoreError::InvalidKey` until the file is manually fixed or deleted).
    pub fn rotate_db_key(&self) -> Result<(), StoreError> {
        let mut new_key_bytes = [0u8; 32];
        csprng_fill(&mut new_key_bytes)
            .map_err(|e| StoreError::Io(format!("CSPRNG failed: {e}")))?;
        let new_key = Zeroizing::new(new_key_bytes);

        let new_key_hex = Zeroizing::new(hex_encode(&*new_key));
        let new_pragma = Zeroizing::new(format!("x'{}'", *new_key_hex));

        let conn = self.lock();
        conn.pragma_update(None, "rekey", new_pragma.as_str())?;

        // Persist the new key. If this write fails the caller gets an error;
        // the DB is already re-encrypted so restarting will show InvalidKey.
        std::fs::write(&self.key_path, &*new_key)
            .map_err(|e| StoreError::Io(format!("failed to write new key file: {e}")))?;

        restrict_key_file_permissions(&self.key_path);
        Ok(())
    }
}

/// Load or create the 32-byte SQLCipher key and lock down file permissions.
///
/// Returns a `Zeroizing` wrapper so the key bytes are wiped from memory when
/// the caller drops the value (after it has been passed to the PRAGMA).
fn load_or_create_db_key(key_path: &Path) -> Result<Zeroizing<[u8; 32]>, StoreError> {
    let key = if key_path.exists() {
        // Read existing key. Use Zeroizing<Vec> so the read buffer is zeroed
        // before being dropped even if we return early.
        let raw = Zeroizing::new(std::fs::read(key_path)?);
        if raw.len() != 32 {
            return Err(StoreError::InvalidKey);
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&*raw);
        Zeroizing::new(out)
    } else {
        let mut bytes = [0u8; 32];
        csprng_fill(&mut bytes)
            .map_err(|e| StoreError::Io(format!("CSPRNG failed: {e}")))?;
        std::fs::write(key_path, bytes)?;
        Zeroizing::new(bytes)
    };

    // Restrict access on the key file so only the current OS user can read it.
    // Called on every open (not just creation) so that permissions are
    // repaired if the file was moved, restored from a backup, or inadvertently
    // made world-readable.
    restrict_key_file_permissions(key_path);

    Ok(key)
}

/// Tighten OS permissions on the key file so only the current user can read it.
///
/// On Windows, removes inherited ACEs and grants the current user full
/// control only. On Unix, sets mode 0600 (owner read/write, no group/other).
/// Errors are logged but not fatal — the key file is still usable even if the
/// ACL update fails (e.g., the user lacks SeSecurityPrivilege on a locked-down
/// machine).
fn restrict_key_file_permissions(key_path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let username = std::env::var("USERNAME").unwrap_or_default();
        if username.is_empty() {
            eprintln!("warn: could not read %USERNAME%; skipping key file ACL tightening");
            return;
        }
        let result = std::process::Command::new("icacls")
            .arg(key_path)
            .arg("/inheritance:r")          // remove inherited ACEs
            .arg("/grant:r")
            .arg(format!("{}:F", username)) // current user: full control only
            .output();
        if let Err(e) = result {
            eprintln!("warn: icacls failed on key file: {e}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) =
            std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))
        {
            eprintln!("warn: could not set 0600 on key file: {e}");
        }
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
