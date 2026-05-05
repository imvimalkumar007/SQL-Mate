// Python sidecar manager. Spawns sidecar/main.py once at app launch, serializes
// requests through an mpsc channel, and restarts on crash with backoff.
//
// Wire protocol pinned by docs/decisions/0009-python-sidecar-lifecycle.md.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CHANNEL_CAP: usize = 32;
const MAX_RESTART_FAILURES: u32 = 3;
const RESTART_BACKOFF: Duration = Duration::from_millis(200);

#[derive(Debug)]
pub enum SidecarError {
    Startup(String),
    Crashed(String),
    Timeout,
    Down,
    Io(String),
    InvalidResponse(String),
    Validation {
        category: String,
        message: String,
        detail: Option<String>,
    },
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarError::Startup(msg) => write!(f, "sidecar startup failed: {msg}"),
            SidecarError::Crashed(msg) => write!(f, "sidecar crashed: {msg}"),
            SidecarError::Timeout => write!(f, "sidecar request timed out"),
            SidecarError::Down => write!(
                f,
                "sidecar is down after repeated restart failures; restart the app"
            ),
            SidecarError::Io(msg) => write!(f, "sidecar I/O error: {msg}"),
            SidecarError::InvalidResponse(msg) => {
                write!(f, "sidecar response not in expected shape: {msg}")
            }
            SidecarError::Validation {
                category,
                message,
                detail,
            } => {
                write!(f, "{message} [{category}]")?;
                if let Some(d) = detail {
                    write!(f, " ({d})")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for SidecarError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatedSql {
    pub sql: String,
    pub referenced_tables: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Handshake {
    #[allow(dead_code)]
    ready: bool,
    #[allow(dead_code)]
    protocol: u32,
    #[allow(dead_code)]
    sqlglot_version: String,
}

#[derive(Debug, Deserialize)]
struct ValidateResponse {
    #[allow(dead_code)]
    id: String,
    ok: bool,
    referenced_tables: Option<Vec<String>>,
    category: Option<String>,
    message: Option<String>,
    detail: Option<String>,
}

enum Message {
    Validate {
        dialect: String,
        sql: String,
        schema: Value,
        reply: oneshot::Sender<Result<ValidatedSql, SidecarError>>,
    },
    Ping {
        reply: oneshot::Sender<Result<(), SidecarError>>,
    },
}

pub struct SidecarManager {
    tx: mpsc::Sender<Message>,
}

impl SidecarManager {
    /// Spawn the sidecar and wait for the startup handshake. Returns when the
    /// child is alive and has emitted `{"ready": true, ...}`.
    pub async fn spawn() -> Result<Self, SidecarError> {
        let (python, script) = sidecar_paths();
        if !python.exists() {
            return Err(SidecarError::Startup(format!(
                "Python venv not found at {}. Run `. .\\dev.ps1` to bootstrap it.",
                python.display()
            )));
        }
        if !script.exists() {
            return Err(SidecarError::Startup(format!(
                "sidecar/main.py not found at {}",
                script.display()
            )));
        }

        let (tx, rx) = mpsc::channel(CHANNEL_CAP);
        let (ready_tx, ready_rx) = oneshot::channel();
        tokio::spawn(supervisor(python, script, rx, ready_tx));
        match tokio::time::timeout(STARTUP_TIMEOUT, ready_rx).await {
            Ok(Ok(Ok(()))) => Ok(Self { tx }),
            Ok(Ok(Err(e))) => Err(e),
            Ok(Err(_)) => Err(SidecarError::Startup("supervisor task dropped".into())),
            Err(_) => Err(SidecarError::Startup("startup timeout".into())),
        }
    }

    pub async fn ping(&self) -> Result<(), SidecarError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Message::Ping { reply })
            .await
            .map_err(|_| SidecarError::Down)?;
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(SidecarError::Down),
            Err(_) => Err(SidecarError::Timeout),
        }
    }

    pub async fn validate(
        &self,
        dialect: &str,
        sql: &str,
        schema: Value,
    ) -> Result<ValidatedSql, SidecarError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Message::Validate {
                dialect: dialect.to_string(),
                sql: sql.to_string(),
                schema,
                reply,
            })
            .await
            .map_err(|_| SidecarError::Down)?;
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(SidecarError::Down),
            Err(_) => Err(SidecarError::Timeout),
        }
    }
}

fn sidecar_paths() -> (PathBuf, PathBuf) {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .expect("CARGO_MANIFEST_DIR has a parent");
    let venv_python = if cfg!(windows) {
        repo_root
            .join("sidecar")
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
    } else {
        repo_root
            .join("sidecar")
            .join(".venv")
            .join("bin")
            .join("python")
    };
    let script = repo_root.join("sidecar").join("main.py");
    (venv_python, script)
}

async fn supervisor(
    python: PathBuf,
    script: PathBuf,
    mut rx: mpsc::Receiver<Message>,
    ready_tx: oneshot::Sender<Result<(), SidecarError>>,
) {
    // First boot — caller is awaiting the ready signal.
    let first_boot = match start_child(&python, &script).await {
        Ok(handles) => {
            let _ = ready_tx.send(Ok(()));
            Some(handles)
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            None
        }
    };

    let mut current = first_boot;
    let mut consecutive_startup_failures = 0u32;

    loop {
        let handles = match current.take() {
            Some(h) => h,
            None => match start_child(&python, &script).await {
                Ok(h) => {
                    consecutive_startup_failures = 0;
                    h
                }
                Err(_) => {
                    consecutive_startup_failures += 1;
                    if consecutive_startup_failures >= MAX_RESTART_FAILURES {
                        drain_channel_with_down(&mut rx).await;
                        return;
                    }
                    tokio::time::sleep(RESTART_BACKOFF).await;
                    continue;
                }
            },
        };

        match run_child_loop(handles, &mut rx).await {
            ChildExit::ChannelClosed => return,
            ChildExit::Crashed => {
                tokio::time::sleep(RESTART_BACKOFF).await;
                // Loop will start a new child.
            }
        }
    }
}

async fn drain_channel_with_down(rx: &mut mpsc::Receiver<Message>) {
    while let Some(msg) = rx.recv().await {
        match msg {
            Message::Validate { reply, .. } => {
                let _ = reply.send(Err(SidecarError::Down));
            }
            Message::Ping { reply } => {
                let _ = reply.send(Err(SidecarError::Down));
            }
        }
    }
}

struct ChildHandles {
    _child: tokio::process::Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

enum ChildExit {
    ChannelClosed,
    Crashed,
}

async fn start_child(python: &Path, script: &Path) -> Result<ChildHandles, SidecarError> {
    let mut child = Command::new(python)
        .arg("-u") // unbuffered stdout, important for line-delimited JSON
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| SidecarError::Startup(format!("spawn failed: {e}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| SidecarError::Startup("child stdin missing".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| SidecarError::Startup("child stdout missing".into()))?;
    let mut reader = BufReader::new(stdout);

    // Read the handshake line.
    let mut line = String::new();
    let read = tokio::time::timeout(STARTUP_TIMEOUT, reader.read_line(&mut line))
        .await
        .map_err(|_| SidecarError::Startup("handshake timeout".into()))?
        .map_err(|e| SidecarError::Startup(format!("read handshake: {e}")))?;
    if read == 0 {
        return Err(SidecarError::Startup(
            "child exited before handshake".into(),
        ));
    }
    serde_json::from_str::<Handshake>(line.trim())
        .map_err(|e| SidecarError::Startup(format!("invalid handshake {line:?}: {e}")))?;

    Ok(ChildHandles {
        _child: child,
        stdin,
        stdout: reader,
    })
}

async fn run_child_loop(
    mut handles: ChildHandles,
    rx: &mut mpsc::Receiver<Message>,
) -> ChildExit {
    loop {
        let msg = match rx.recv().await {
            Some(m) => m,
            None => return ChildExit::ChannelClosed,
        };
        let result = handle_message(&mut handles, msg).await;
        match result {
            HandleOutcome::Ok => continue,
            HandleOutcome::ChildBroken => return ChildExit::Crashed,
        }
    }
}

enum HandleOutcome {
    Ok,
    ChildBroken,
}

async fn handle_message(handles: &mut ChildHandles, msg: Message) -> HandleOutcome {
    match msg {
        Message::Ping { reply } => {
            let req = serde_json::json!({"id": "ping", "kind": "ping"});
            match round_trip(handles, &req).await {
                Ok(_value) => {
                    let _ = reply.send(Ok(()));
                    HandleOutcome::Ok
                }
                Err(e) => {
                    let broken = is_broken(&e);
                    let _ = reply.send(Err(e));
                    if broken {
                        HandleOutcome::ChildBroken
                    } else {
                        HandleOutcome::Ok
                    }
                }
            }
        }
        Message::Validate {
            dialect,
            sql,
            schema,
            reply,
        } => {
            let id = uuid::Uuid::new_v4().to_string();
            let req = serde_json::json!({
                "id": id,
                "kind": "validate",
                "dialect": dialect,
                "sql": sql,
                "schema": schema,
            });
            match round_trip(handles, &req).await {
                Ok(value) => {
                    let result = parse_validate_response(value, sql);
                    let _ = reply.send(result);
                    HandleOutcome::Ok
                }
                Err(e) => {
                    let broken = is_broken(&e);
                    let _ = reply.send(Err(e));
                    if broken {
                        HandleOutcome::ChildBroken
                    } else {
                        HandleOutcome::Ok
                    }
                }
            }
        }
    }
}

fn is_broken(e: &SidecarError) -> bool {
    matches!(
        e,
        SidecarError::Crashed(_) | SidecarError::Timeout | SidecarError::Io(_)
    )
}

async fn round_trip(handles: &mut ChildHandles, req: &Value) -> Result<Value, SidecarError> {
    let line = serde_json::to_string(req).map_err(|e| SidecarError::Io(e.to_string()))?;
    handles
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| SidecarError::Io(e.to_string()))?;
    handles
        .stdin
        .write_all(b"\n")
        .await
        .map_err(|e| SidecarError::Io(e.to_string()))?;
    handles
        .stdin
        .flush()
        .await
        .map_err(|e| SidecarError::Io(e.to_string()))?;

    let mut resp_line = String::new();
    let read = tokio::time::timeout(REQUEST_TIMEOUT, handles.stdout.read_line(&mut resp_line))
        .await
        .map_err(|_| SidecarError::Timeout)?
        .map_err(|e| SidecarError::Io(e.to_string()))?;
    if read == 0 {
        return Err(SidecarError::Crashed("EOF on stdout".into()));
    }
    serde_json::from_str(resp_line.trim()).map_err(|e| {
        SidecarError::InvalidResponse(format!("{e}; got: {}", resp_line.trim()))
    })
}

fn parse_validate_response(resp: Value, sql: String) -> Result<ValidatedSql, SidecarError> {
    let parsed: ValidateResponse = serde_json::from_value(resp)
        .map_err(|e| SidecarError::InvalidResponse(e.to_string()))?;
    if parsed.ok {
        Ok(ValidatedSql {
            sql,
            referenced_tables: parsed.referenced_tables.unwrap_or_default(),
        })
    } else {
        Err(SidecarError::Validation {
            category: parsed.category.unwrap_or_else(|| "unknown".into()),
            message: parsed.message.unwrap_or_default(),
            detail: parsed.detail,
        })
    }
}
