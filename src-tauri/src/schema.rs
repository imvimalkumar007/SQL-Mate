// Canonical schema model. Every ingestion path normalizes to this shape; every
// downstream module (LLM provider, validator, UI) reads from it. See
// docs/ARCHITECTURE.md for the design.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaModel {
    pub dialect: Dialect,
    pub schemas: Vec<DbSchema>,
    pub extracted_at: i64,
    pub source: ExtractionSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dialect {
    Postgres,
    // MySql, Sqlite, MsSql land in Phase 6.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExtractionSource {
    Live { connection_id: String },
    // FileImport variants are out of v1 scope per docs/PROJECT_BRIEF.md.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbSchema {
    pub name: String,
    pub tables: Vec<Table>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    #[serde(default)]
    pub user_annotation: Option<String>,
    #[serde(default)]
    pub excluded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub user_annotation: Option<String>,
    #[serde(default)]
    pub sensitive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKey {
    pub columns: Vec<String>,
    pub references_schema: String,
    pub references_table: String,
    pub references_columns: Vec<String>,
}
