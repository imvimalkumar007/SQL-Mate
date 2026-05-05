// Schema-extraction dispatcher. Per ADR 0012, Phase 6 supports Postgres and
// MySQL; SQLite and SQL Server are named deferrals.

pub mod mysql;
pub mod postgres;

use serde::Deserialize;

use crate::schema::SchemaModel;

pub use mysql::MySqlConnectionParams;
pub use postgres::PgConnectionParams;

#[derive(Debug)]
pub enum ExtractError {
    Connection(String),
    Auth(String),
    PermissionDenied(String),
    EmptyResult,
    Timeout,
    Other(String),
    UnsupportedDialect(String),
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractError::Connection(msg) => write!(f, "Could not reach database. {msg}"),
            ExtractError::Auth(msg) => write!(
                f,
                "Authentication failed. Check username and password. {msg}"
            ),
            ExtractError::PermissionDenied(msg) => write!(
                f,
                "Permission denied. Your database role cannot read schema metadata. \
                 Ask a DBA to grant SELECT on information_schema. ({msg})"
            ),
            ExtractError::EmptyResult => write!(
                f,
                "Connected, but no tables visible to this role. \
                 Check that the role has access to a non-system schema."
            ),
            ExtractError::Timeout => write!(f, "Schema extraction timed out."),
            ExtractError::Other(msg) => write!(f, "{msg}"),
            ExtractError::UnsupportedDialect(d) => write!(
                f,
                "Dialect '{d}' is not yet supported. Postgres and MySQL are available; \
                 SQLite and SQL Server are tracked in PHASE_6_LOG.md."
            ),
        }
    }
}

impl std::error::Error for ExtractError {}

pub(crate) fn classify_connect_error(e: sqlx::Error) -> ExtractError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("password authentication")
        || lower.contains("authentication failed")
        || lower.contains("access denied")
    {
        ExtractError::Auth(msg)
    } else {
        ExtractError::Connection(msg)
    }
}

pub(crate) fn classify_query_error(e: sqlx::Error) -> ExtractError {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("permission denied") || lower.contains("access denied") {
        ExtractError::PermissionDenied(msg)
    } else if lower.contains("statement timeout")
        || lower.contains("canceling statement")
        || lower.contains("query execution was interrupted")
    {
        ExtractError::Timeout
    } else {
        ExtractError::Other(msg)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: String,
}

pub async fn test_connection(dialect: &str, params: ConnectionParams) -> Result<(), ExtractError> {
    match dialect {
        "postgres" => {
            postgres::test_connection(PgConnectionParams {
                host: params.host,
                port: params.port,
                database: params.database,
                username: params.username,
                password: params.password,
            })
            .await
        }
        "mysql" => {
            mysql::test_connection(MySqlConnectionParams {
                host: params.host,
                port: params.port,
                database: params.database,
                username: params.username,
                password: params.password,
            })
            .await
        }
        other => Err(ExtractError::UnsupportedDialect(other.to_string())),
    }
}

pub async fn extract_schema(
    dialect: &str,
    params: ConnectionParams,
    connection_id: &str,
) -> Result<SchemaModel, ExtractError> {
    match dialect {
        "postgres" => {
            postgres::extract_schema(
                PgConnectionParams {
                    host: params.host,
                    port: params.port,
                    database: params.database,
                    username: params.username,
                    password: params.password,
                },
                connection_id,
            )
            .await
        }
        "mysql" => {
            mysql::extract_schema(
                MySqlConnectionParams {
                    host: params.host,
                    port: params.port,
                    database: params.database,
                    username: params.username,
                    password: params.password,
                },
                connection_id,
            )
            .await
        }
        other => Err(ExtractError::UnsupportedDialect(other.to_string())),
    }
}
