// Phase 8: ephemeral, in-memory request log. Captures the exact prompt that
// went out for each connection's most recent generate_sql call, so the user
// can verify that excluded tables are absent and sensitive columns are
// obfuscated before trusting the output.
//
// Not persisted. Lifetime is the app process; cleared on restart.
//
// Stores the *post-obfuscation* user_message, which is the bytes that
// actually traveled the wire. Showing the pre-obfuscation form would defeat
// the purpose of the log — the user is auditing what the LLM saw, not what
// they typed.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RequestLogEntry {
    pub timestamp: i64,
    pub model: String,
    pub provider_kind: String,
    pub system_prompt: String,
    /// The schema-text + question block as sent to the LLM, with sensitive
    /// columns already replaced by their `r_c_<n>` placeholders.
    pub user_message: String,
    /// Number of column-level placeholders applied. Zero means no
    /// obfuscation was needed (no sensitive columns in the slice).
    pub obfuscated_columns: usize,
    /// Tables omitted from the prompt because they were marked excluded.
    pub excluded_tables: Vec<String>,
}

pub struct RequestLog {
    inner: Mutex<HashMap<String, RequestLogEntry>>,
}

impl RequestLog {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn record(&self, connection_id: &str, entry: RequestLogEntry) {
        let mut g = self.inner.lock().expect("request log mutex poisoned");
        g.insert(connection_id.to_string(), entry);
    }

    pub fn last(&self, connection_id: &str) -> Option<RequestLogEntry> {
        let g = self.inner.lock().expect("request log mutex poisoned");
        g.get(connection_id).cloned()
    }
}
