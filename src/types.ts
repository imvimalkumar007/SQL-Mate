// TypeScript mirrors of the Rust types we send across the Tauri boundary.
// Kept here so components import a single source of truth.

export type ConnectionProfile = {
  id: string;
  name: string;
  dialect: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  // password is on the Rust side (#[serde(skip_serializing)]); never reaches the frontend.
  created_at: number;
  last_used_at: number | null;
};

export type SchemaModel = {
  dialect: string;
  schemas: DbSchema[];
  extracted_at: number;
  source: { kind: string; connection_id?: string };
};

export type DbSchema = {
  name: string;
  tables: Table[];
};

export type Table = {
  name: string;
  columns: Column[];
  primary_key: string[];
  foreign_keys: ForeignKey[];
  user_annotation: string | null;
  excluded: boolean;
};

export type Column = {
  name: string;
  data_type: string;
  nullable: boolean;
  default: string | null;
  user_annotation: string | null;
  sensitive: boolean;
};

export type ForeignKey = {
  columns: string[];
  references_schema: string;
  references_table: string;
  references_columns: string[];
};

export type ValidatedSql = {
  sql: string;
  referenced_tables: string[];
};

export type ExecutionResult = {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
};

export type ProviderKind = "anthropic" | "openai" | "openai_compatible";

export type ProviderConfig = {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
  // api_key never reaches the frontend (#[serde(skip_serializing)] on the Rust side).
  created_at: number;
};

export type CostTier = "low" | "mid" | "high";

export type ModelRegistryModel = {
  id: string;
  name: string;
  context_window: number;
  supports_caching: boolean;
  supports_structured_output: boolean;
  cost_tier: CostTier;
  recommended_for?: string;
};

export type ModelRegistryProvider = {
  id: string;
  name: string;
  kind: ProviderKind;
  default_base_url: string;
  models: ModelRegistryModel[];
  retention_note: string;
};

export type ModelRegistry = {
  version: number;
  providers: ModelRegistryProvider[];
};

export type EmbeddingStats = {
  total_tables: number;
  embedded_count: number;
  model: string | null;
  embedded_at: number | null;
  retrieval_threshold: number;
  retrieval_top_n: number;
};

export type GenerationResult = {
  sql: string;
  history_id: string;
  model: string;
};

export type HistoryEntry = {
  id: string;
  connection_id: string;
  asked_at: number;
  question: string;
  generated_sql: string | null;
  validation_status: string;
  validation_error: string | null;
  was_executed: boolean;
  execution_row_count: number | null;
  execution_duration_ms: number | null;
};

export type Annotation = {
  connection_id: string;
  schema_name: string;
  table_name: string;
  column_name: string | null;
  annotation: string;
};

export type Redaction = {
  connection_id: string;
  schema_name: string;
  table_name: string;
  column_name: string | null;
  kind: "excluded" | "sensitive";
};

export type RequestLogEntry = {
  timestamp: number;
  model: string;
  provider_kind: string;
  system_prompt: string;
  user_message: string;
  obfuscated_columns: number;
  excluded_tables: string[];
};
