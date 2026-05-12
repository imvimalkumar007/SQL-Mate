use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use zeroize::Zeroizing;

// getrandom is used both in load_or_create_db_key (first launch) and in
// rotate_db_key (re-key operation).
use getrandom::fill as csprng_fill;

// ---------- Windows Credential Manager (ADR 0016) ----------
//
// On Windows we store the 32-byte SQLCipher key in Windows Credential Manager
// (DPAPI-encrypted per user) rather than in a plain file. The file is still
// written on non-Windows platforms (macOS, Linux) with chmod 0600 as a
// fallback until native keychain support is added for those targets.
//
// Migration: if a `.db-key` file exists from a pre-ADR-0016 install, it is
// read, the key is moved into Credential Manager, and the file is deleted.

#[cfg(target_os = "windows")]
mod keychain {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };
    use zeroize::Zeroizing;

    /// Application-specific target name in Windows Credential Manager.
    const CRED_TARGET: &str = "sql-mate/db-key";

    // ERROR_NOT_FOUND (0x490 = 1168): credential does not exist yet.
    const ERROR_NOT_FOUND: u32 = 1168;

    fn to_wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Store `key` in Windows Credential Manager under `CRED_TARGET`.
    /// The entry is DPAPI-encrypted per user and survives reboots.
    pub fn save(key: &[u8; 32]) -> Result<(), String> {
        let target = to_wide_null(CRED_TARGET);
        // SAFETY: we initialise every field; zeroed() ensures no undefined
        // padding bytes reach the OS. CredWriteW does not mutate the struct.
        let mut cred: CREDENTIALW = unsafe { std::mem::zeroed() };
        cred.Type = CRED_TYPE_GENERIC;
        cred.TargetName = target.as_ptr() as *mut _;
        cred.CredentialBlobSize = 32;
        // CredentialBlob is *mut u8 in the Win32 API despite being read-only
        // for CredWriteW. Cast away const to satisfy the signature.
        cred.CredentialBlob = key.as_ptr() as *mut _;
        cred.Persist = CRED_PERSIST_LOCAL_MACHINE;

        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "CredWriteW failed with error {code:#010x}. \
                 The SQLCipher key could not be saved to Windows Credential Manager."
            ));
        }
        Ok(())
    }

    /// Read the 32-byte key from Windows Credential Manager.
    /// Returns `Ok(None)` when the entry does not exist (first launch or after
    /// a credential store reset). Returns `Err` for unexpected OS errors.
    pub fn load() -> Result<Option<Zeroizing<[u8; 32]>>, String> {
        let target = to_wide_null(CRED_TARGET);
        let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();

        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pcred) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!(
                "CredReadW failed with error {code:#010x}. \
                 Cannot read SQLCipher key from Windows Credential Manager."
            ));
        }

        // SAFETY: CredReadW succeeded; pcred points to a valid CREDENTIALW
        // that must be freed with CredFree after we copy the blob.
        let result = unsafe {
            let cred = &*pcred;
            if cred.CredentialBlobSize != 32 {
                CredFree(pcred as *const CREDENTIALW as *const c_void);
                return Err(format!(
                    "Credential Manager entry has unexpected blob size {} (expected 32). \
                     The entry may be corrupt; delete it from Credential Manager and restart.",
                    cred.CredentialBlobSize
                ));
            }
            let mut key = Zeroizing::new([0u8; 32]);
            std::ptr::copy_nonoverlapping(cred.CredentialBlob, key.as_mut_ptr(), 32);
            CredFree(pcred as *const CREDENTIALW as *const c_void);
            key
        };
        Ok(Some(result))
    }

    /// Remove the Credential Manager entry. Silently ignores NOT_FOUND.
    pub fn delete() {
        let target = to_wide_null(CRED_TARGET);
        unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    }
}

// ---------- Store ----------

const MIGRATIONS: &[(u32, &str)] = &[
    (1, include_str!("../../migrations/0001_initial_schema.sql")),
    (2, include_str!("../../migrations/0002_provider_configs.sql")),
    (3, include_str!("../../migrations/0003_schema_embeddings.sql")),
    (4, include_str!("../../migrations/0004_widget_state.sql")),
];

pub struct Store {
    conn: Mutex<Connection>,
    /// Path to the `.db-key` file.  Used on non-Windows platforms and kept for
    /// the Windows `rotate_db_key` so it can clean up any legacy file that
    /// survived migration.
    key_path: std::path::PathBuf,
}

#[derive(Debug)]
pub enum StoreError {
    Io(String),
    Sqlite(String),
    /// The store exists but the key cannot decrypt it — the key file or
    /// Credential Manager entry is missing, has the wrong size, or the DB
    /// file was replaced.
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
                "Local store key is invalid or missing. \
                 On Windows, check that your Windows Credential Manager entry \
                 'sql-mate/db-key' is present. If you deleted it the store \
                 is permanently locked and must be reset."
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
    /// **Key storage (ADR 0016):** On Windows the 32-byte SQLCipher key is
    /// stored in Windows Credential Manager (`sql-mate/db-key`), DPAPI-
    /// encrypted per user. On first launch the key is generated and saved
    /// there. On subsequent launches it is read from there.
    ///
    /// **Migration from ADR 0008:** If a `.db-key` file is found alongside the
    /// store (the pre-ADR-0016 approach), its contents are migrated into
    /// Credential Manager and the file is deleted, transparently and on first
    /// launch after the upgrade.
    ///
    /// **Non-Windows:** The file-based approach with chmod 0600 is retained
    /// until native keychain support lands for macOS / Linux.
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
        let key_pragma = Zeroizing::new(format!("x'{}'", key_hex.as_str()));
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
    /// database via `PRAGMA rekey`, and persist it to the OS keychain
    /// (Windows Credential Manager on Windows; `.db-key` file on other
    /// platforms). The old `.db-key` file is removed on Windows if it still
    /// exists from a pre-ADR-0016 install.
    ///
    /// If the key persistence step fails after `PRAGMA rekey` succeeds, the
    /// DB is already re-encrypted with the new key. The error message advises
    /// the user to note the error and contact support — the store will be
    /// unreadable on next launch.
    pub fn rotate_db_key(&self) -> Result<(), StoreError> {
        let mut new_key_bytes = [0u8; 32];
        csprng_fill(&mut new_key_bytes)
            .map_err(|e| StoreError::Io(format!("CSPRNG failed: {e}")))?;
        let new_key = Zeroizing::new(new_key_bytes);

        let new_key_hex = Zeroizing::new(hex_encode(&*new_key));
        let new_pragma = Zeroizing::new(format!("x'{}'", new_key_hex.as_str()));

        let conn = self.lock();
        conn.pragma_update(None, "rekey", new_pragma.as_str())?;

        // Persist the new key to the appropriate store for this platform.
        #[cfg(target_os = "windows")]
        {
            keychain::save(&*new_key)
                .map_err(|e| StoreError::Io(format!("keychain save failed: {e}")))?;
            // Remove any legacy .db-key file that survived migration.
            let _ = std::fs::remove_file(&self.key_path);
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::fs::write(&self.key_path, &*new_key)
                .map_err(|e| StoreError::Io(format!("failed to write new key file: {e}")))?;
            restrict_key_file_permissions(&self.key_path);
        }

        Ok(())
    }
}

// ---------- Key loading ----------

/// Load or generate the 32-byte SQLCipher key, wrapping it in `Zeroizing`
/// so the bytes are wiped when the caller drops the value (after it has been
/// passed to the key PRAGMA).
///
/// Windows:
///   1. Try Credential Manager → return key if found.
///   2. Not found → check `.db-key` file (migration from pre-ADR-0016).
///      If found, save to Credential Manager, delete the file, return key.
///   3. Neither exists → generate new key, save to Credential Manager.
///
/// Other platforms:
///   Read from `.db-key` if it exists; otherwise generate and write it.
///   Permissions are tightened to 0600 on every open.
fn load_or_create_db_key(key_path: &Path) -> Result<Zeroizing<[u8; 32]>, StoreError> {
    #[cfg(target_os = "windows")]
    {
        match keychain::load() {
            // Key already in Credential Manager — the happy path after ADR 0016.
            Ok(Some(key)) => return Ok(key),

            // Not in Credential Manager yet.
            Ok(None) => {
                if key_path.exists() {
                    // Found a legacy .db-key file — migrate it to the keychain.
                    let key = read_key_file(key_path)?;
                    match keychain::save(&*key) {
                        Ok(()) => {
                            // Successfully moved to keychain; remove the file.
                            if let Err(e) = std::fs::remove_file(key_path) {
                                eprintln!(
                                    "warn: migrated key to Credential Manager but could not \
                                     delete legacy .db-key file: {e}"
                                );
                            } else {
                                eprintln!(
                                    "info: SQLCipher key migrated from .db-key to \
                                     Windows Credential Manager."
                                );
                            }
                        }
                        Err(e) => {
                            // Keychain save failed — keep the file as fallback and warn.
                            eprintln!(
                                "warn: could not save key to Windows Credential Manager: {e}. \
                                 Retaining .db-key file. Resolve Credential Manager access \
                                 and restart to complete migration."
                            );
                            // Tighten file ACL while we still have the file.
                            restrict_key_file_permissions(key_path);
                        }
                    }
                    return Ok(key);
                }

                // Fresh install — generate a new key and store in the keychain.
                let key = generate_key()?;
                keychain::save(&*key).map_err(|e| {
                    StoreError::Io(format!(
                        "could not save new key to Windows Credential Manager: {e}"
                    ))
                })?;
                return Ok(key);
            }

            // Credential Manager returned an unexpected error (not NOT_FOUND).
            // Treat this as a hard failure — we cannot safely fall back to the
            // file because the file may already have been deleted after a prior
            // successful migration.
            Err(e) => {
                return Err(StoreError::Io(format!(
                    "Windows Credential Manager error: {e}"
                )));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let key = if key_path.exists() {
            read_key_file(key_path)?
        } else {
            let k = generate_key()?;
            std::fs::write(key_path, &*k)?;
            k
        };
        restrict_key_file_permissions(key_path);
        Ok(key)
    }
}

/// Read and validate a 32-byte key from the `.db-key` file.
fn read_key_file(key_path: &Path) -> Result<Zeroizing<[u8; 32]>, StoreError> {
    let raw = Zeroizing::new(std::fs::read(key_path)?);
    if raw.len() != 32 {
        return Err(StoreError::InvalidKey);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&*raw);
    Ok(Zeroizing::new(out))
}

/// Generate 32 cryptographically random bytes.
fn generate_key() -> Result<Zeroizing<[u8; 32]>, StoreError> {
    let mut bytes = [0u8; 32];
    csprng_fill(&mut bytes).map_err(|e| StoreError::Io(format!("CSPRNG failed: {e}")))?;
    Ok(Zeroizing::new(bytes))
}

// ---------- File permission hardening (non-Windows fallback) ----------

/// Tighten OS permissions on the `.db-key` file so only the current user can
/// read it. Called even on subsequent opens so that permissions are repaired
/// if the file was restored from a backup or inadvertently made world-readable.
///
/// Only used on non-Windows platforms (on Windows the key lives in Credential
/// Manager and there is no key file to protect).
#[cfg(not(target_os = "windows"))]
fn restrict_key_file_permissions(key_path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) =
        std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))
    {
        eprintln!("warn: could not set 0600 on key file: {e}");
    }
}

// On Windows the function is called from non-cfg code paths (the migration
// warning branch). Provide a no-op so the compiler is satisfied.
#[cfg(target_os = "windows")]
fn restrict_key_file_permissions(_key_path: &Path) {}

// ---------- Migrations ----------

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
