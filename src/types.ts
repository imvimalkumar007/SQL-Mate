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
  keychain_ref: string;
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
