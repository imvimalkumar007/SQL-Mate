// Phase 8: schema overlay (apply persisted annotations + redactions onto a
// freshly-loaded SchemaModel) and the obfuscation pipeline that swaps
// sensitive column names for stable placeholders before the schema text
// goes to the LLM.
//
// Two paths through this module:
//
//   load_schema → apply_overlay  → schema model with user_annotation /
//                                  excluded / sensitive set on the right
//                                  Tables and Columns
//
//   apply_overlay → Obfuscator   → schema with sensitive Column.name swapped
//                                  for placeholder ids; mapping kept in
//                                  memory for the lifetime of the request
//                                  and used by deobfuscate_sql() on the
//                                  generated SQL on the way back.
//
// We deliberately do not persist the obfuscation mapping. A new mapping is
// built per generate_sql call, used once, dropped. This is the same pattern
// docs/architecture/sql-generation.md prescribed for redaction.

use std::collections::BTreeMap;

use crate::schema::SchemaModel;
use crate::store::{Annotation, Redaction};

/// Mutate the schema model in place to reflect the persisted annotations
/// (table-level and column-level) and redactions (excluded tables, sensitive
/// columns) for this connection.
///
/// Annotations or redactions whose target Table or Column no longer exists
/// in the freshly-loaded schema are silently ignored — that case happens
/// after a re-extraction drops a table. The orphan rows stay in the store
/// until the user clears them.
pub fn apply_overlay(
    model: &mut SchemaModel,
    annotations: &[Annotation],
    redactions: &[Redaction],
) {
    for ann in annotations {
        let Some(db) = model.schemas.iter_mut().find(|s| s.name == ann.schema_name) else {
            continue;
        };
        let Some(tbl) = db.tables.iter_mut().find(|t| t.name == ann.table_name) else {
            continue;
        };
        match &ann.column_name {
            None => tbl.user_annotation = Some(ann.annotation.clone()),
            Some(c) => {
                if let Some(col) = tbl.columns.iter_mut().find(|x| &x.name == c) {
                    col.user_annotation = Some(ann.annotation.clone());
                }
            }
        }
    }

    for red in redactions {
        let Some(db) = model.schemas.iter_mut().find(|s| s.name == red.schema_name) else {
            continue;
        };
        let Some(tbl) = db.tables.iter_mut().find(|t| t.name == red.table_name) else {
            continue;
        };
        match (red.kind.as_str(), &red.column_name) {
            ("excluded", None) => tbl.excluded = true,
            ("sensitive", Some(c)) => {
                if let Some(col) = tbl.columns.iter_mut().find(|x| &x.name == c) {
                    col.sensitive = true;
                }
            }
            // Mismatched shapes silently no-op. The store layer rejects them
            // on insert; defending here makes us robust to direct DB edits.
            _ => {}
        }
    }
}

/// Deterministic placeholder generator for sensitive columns. Mapping is
/// global across the schema (not per-table) so the LLM sees a uniform
/// `r_c_1` / `r_c_2` namespace.
pub struct Obfuscator {
    /// placeholder → original (used by deobfuscate_sql)
    inverse: Vec<(String, String)>,
    /// original (qualified) → placeholder (used during model rewrite)
    forward: BTreeMap<String, String>,
    next_id: usize,
}

impl Obfuscator {
    pub fn new() -> Self {
        Self {
            inverse: Vec::new(),
            forward: BTreeMap::new(),
            next_id: 1,
        }
    }

    /// Apply obfuscation in place. Sensitive Columns get their `name` swapped
    /// for a placeholder; FK `columns` and `references_columns` arrays are
    /// also renamed so the LLM sees a consistent namespace. Excluded tables
    /// are *not* obfuscated here — `format_schema_for_prompt` already skips
    /// them entirely.
    pub fn apply(&mut self, model: &mut SchemaModel) {
        // Pass 1: rename the column inside its owning table and record the
        // mapping. Qualified by schema.table to stay unambiguous when the
        // same column name appears in multiple tables.
        for db in model.schemas.iter_mut() {
            for tbl in db.tables.iter_mut() {
                if tbl.excluded {
                    continue;
                }
                for col in tbl.columns.iter_mut() {
                    if !col.sensitive {
                        continue;
                    }
                    let original = col.name.clone();
                    let placeholder = self.fresh_placeholder();
                    let key = format!("{}.{}.{}", db.name, tbl.name, original);
                    self.forward.insert(key, placeholder.clone());
                    self.inverse
                        .push((placeholder.clone(), original.clone()));
                    col.name = placeholder;
                }
            }
        }

        // Pass 2: rewrite primary_key arrays + FK column lists (both sides)
        // so they match the renamed columns. Only the column names change,
        // never table or schema names — v1 sensitive applies to columns only.
        let forward = self.forward.clone();
        for db in model.schemas.iter_mut() {
            for tbl in db.tables.iter_mut() {
                for pk in tbl.primary_key.iter_mut() {
                    let key = format!("{}.{}.{}", db.name, tbl.name, pk);
                    if let Some(p) = forward.get(&key) {
                        *pk = p.clone();
                    }
                }
                for fk in tbl.foreign_keys.iter_mut() {
                    for col in fk.columns.iter_mut() {
                        let key = format!("{}.{}.{}", db.name, tbl.name, col);
                        if let Some(p) = forward.get(&key) {
                            *col = p.clone();
                        }
                    }
                    for col in fk.references_columns.iter_mut() {
                        let key = format!(
                            "{}.{}.{}",
                            fk.references_schema, fk.references_table, col
                        );
                        if let Some(p) = forward.get(&key) {
                            *col = p.clone();
                        }
                    }
                }
            }
        }
    }

    /// `true` if at least one column was obfuscated.
    pub fn has_replacements(&self) -> bool {
        !self.inverse.is_empty()
    }

    /// Number of column-level placeholders applied. Used by the request log.
    pub fn replacement_count(&self) -> usize {
        self.inverse.len()
    }

    /// Substitute placeholders back to original column names in generated SQL.
    /// Word-boundary aware: `r_c_1` inside the larger token `r_c_10` is not
    /// a match. Longer placeholders are tried first so substitution is
    /// stable when the namespace grows past 10.
    pub fn deobfuscate_sql(&self, sql: &str) -> String {
        let mut sorted = self.inverse.clone();
        sorted.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        let mut out = sql.to_string();
        for (placeholder, original) in sorted {
            out = replace_word(&out, &placeholder, &original);
        }
        out
    }

    fn fresh_placeholder(&mut self) -> String {
        let id = self.next_id;
        self.next_id += 1;
        format!("r_c_{id}")
    }
}

fn replace_word(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let bytes = text.as_bytes();
    let from_bytes = from.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + from_bytes.len() <= bytes.len() && &bytes[i..i + from_bytes.len()] == from_bytes {
            let before_ok = i == 0 || !is_id_char(bytes[i - 1]);
            let after_ok =
                i + from_bytes.len() == bytes.len() || !is_id_char(bytes[i + from_bytes.len()]);
            if before_ok && after_ok {
                out.push_str(to);
                i += from_bytes.len();
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn is_id_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Column, DbSchema, Dialect, ExtractionSource, ForeignKey, Table};

    fn fresh_model() -> SchemaModel {
        SchemaModel {
            dialect: Dialect::Postgres,
            schemas: vec![DbSchema {
                name: "public".into(),
                tables: vec![Table {
                    name: "users".into(),
                    columns: vec![
                        Column {
                            name: "id".into(),
                            data_type: "bigint".into(),
                            nullable: false,
                            default: None,
                            user_annotation: None,
                            sensitive: false,
                        },
                        Column {
                            name: "email".into(),
                            data_type: "text".into(),
                            nullable: false,
                            default: None,
                            user_annotation: None,
                            sensitive: false,
                        },
                        Column {
                            name: "ssn".into(),
                            data_type: "text".into(),
                            nullable: true,
                            default: None,
                            user_annotation: None,
                            sensitive: false,
                        },
                    ],
                    primary_key: vec!["id".into()],
                    foreign_keys: vec![],
                    user_annotation: None,
                    excluded: false,
                }],
            }],
            extracted_at: 0,
            source: ExtractionSource::Live {
                connection_id: "c1".into(),
            },
        }
    }

    #[test]
    fn overlay_applies_table_annotation_and_excluded() {
        let mut model = fresh_model();
        let anns = vec![Annotation {
            connection_id: "c1".into(),
            schema_name: "public".into(),
            table_name: "users".into(),
            column_name: None,
            annotation: "the canonical user table".into(),
        }];
        let reds = vec![Redaction {
            connection_id: "c1".into(),
            schema_name: "public".into(),
            table_name: "users".into(),
            column_name: None,
            kind: "excluded".into(),
        }];
        apply_overlay(&mut model, &anns, &reds);
        let t = &model.schemas[0].tables[0];
        assert_eq!(t.user_annotation.as_deref(), Some("the canonical user table"));
        assert!(t.excluded);
    }

    #[test]
    fn overlay_applies_column_sensitive_and_annotation() {
        let mut model = fresh_model();
        let anns = vec![Annotation {
            connection_id: "c1".into(),
            schema_name: "public".into(),
            table_name: "users".into(),
            column_name: Some("ssn".into()),
            annotation: "social security number, regulated".into(),
        }];
        let reds = vec![Redaction {
            connection_id: "c1".into(),
            schema_name: "public".into(),
            table_name: "users".into(),
            column_name: Some("ssn".into()),
            kind: "sensitive".into(),
        }];
        apply_overlay(&mut model, &anns, &reds);
        let col = &model.schemas[0].tables[0].columns[2];
        assert_eq!(
            col.user_annotation.as_deref(),
            Some("social security number, regulated")
        );
        assert!(col.sensitive);
    }

    #[test]
    fn obfuscator_renames_sensitive_columns_and_deobfuscates_sql() {
        let mut model = fresh_model();
        model.schemas[0].tables[0].columns[1].sensitive = true; // email
        model.schemas[0].tables[0].columns[2].sensitive = true; // ssn

        let mut obf = Obfuscator::new();
        obf.apply(&mut model);
        assert!(obf.has_replacements());

        let cols = &model.schemas[0].tables[0].columns;
        assert_eq!(cols[0].name, "id"); // unchanged
        assert_ne!(cols[1].name, "email");
        assert_ne!(cols[2].name, "ssn");

        let placeholder_for_email = cols[1].name.clone();
        let placeholder_for_ssn = cols[2].name.clone();

        let sql = format!(
            "SELECT {p_email}, {p_ssn} FROM public.users WHERE {p_email} LIKE '%@example.com'",
            p_email = placeholder_for_email,
            p_ssn = placeholder_for_ssn
        );
        let restored = obf.deobfuscate_sql(&sql);
        assert!(restored.contains("email"));
        assert!(restored.contains("ssn"));
        assert!(!restored.contains("r_c_"));
    }

    #[test]
    fn deobfuscate_respects_word_boundaries() {
        let mut obf = Obfuscator::new();
        // Inject a placeholder pair manually for a focused boundary test.
        obf.inverse.push(("r_c_1".into(), "real_name".into()));
        let sql = "SELECT r_c_1, r_c_10 FROM t";
        let out = obf.deobfuscate_sql(sql);
        // r_c_1 gets restored; r_c_10 is left alone because it's a longer token
        // we don't have a mapping for.
        assert!(out.contains("real_name"));
        assert!(out.contains("r_c_10"));
    }

    #[test]
    fn overlay_ignores_orphans_after_reextraction() {
        let mut model = fresh_model();
        let anns = vec![Annotation {
            connection_id: "c1".into(),
            schema_name: "public".into(),
            table_name: "ghosts".into(), // table no longer exists
            column_name: None,
            annotation: "should be ignored".into(),
        }];
        apply_overlay(&mut model, &anns, &[]);
        // No panic, no change to existing table.
        assert!(model.schemas[0].tables[0].user_annotation.is_none());
    }

    #[test]
    fn obfuscator_renames_fk_references() {
        let mut model = fresh_model();
        model.schemas[0].tables.push(Table {
            name: "orders".into(),
            columns: vec![Column {
                name: "user_id".into(),
                data_type: "bigint".into(),
                nullable: false,
                default: None,
                user_annotation: None,
                sensitive: true,
            }],
            primary_key: vec![],
            foreign_keys: vec![ForeignKey {
                columns: vec!["user_id".into()],
                references_schema: "public".into(),
                references_table: "users".into(),
                references_columns: vec!["id".into()],
            }],
            user_annotation: None,
            excluded: false,
        });

        let mut obf = Obfuscator::new();
        obf.apply(&mut model);

        let orders = &model.schemas[0].tables[1];
        let renamed = orders.columns[0].name.clone();
        assert_ne!(renamed, "user_id");
        // FK columns array should match the new column name.
        assert_eq!(orders.foreign_keys[0].columns[0], renamed);
        // references_columns points at users.id which is NOT sensitive,
        // so it stays unchanged.
        assert_eq!(orders.foreign_keys[0].references_columns[0], "id");
    }
}
