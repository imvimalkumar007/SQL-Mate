// Embedding-based schema retrieval. See ADR 0011.
//
// Activates only when the canonical SchemaModel has more tables than
// `RETRIEVAL_THRESHOLD`. Computes cosine similarity between the question
// embedding and each stored table embedding, picks the top N, then expands
// with the FK neighborhood from the schema model.

use std::collections::HashSet;

use crate::schema::{DbSchema, SchemaModel, Table};
use crate::store::embeddings::StoredEmbedding;

pub const RETRIEVAL_THRESHOLD: usize = 50;
pub const RETRIEVAL_TOP_N: usize = 20;

pub fn total_table_count(model: &SchemaModel) -> usize {
    model.schemas.iter().map(|s| s.tables.len()).sum()
}

/// Build the text we feed to the embedding model for a single table.
/// Includes the qualified name and the columns with types — what the LLM
/// would need to recognize the table is relevant.
pub fn embedding_text(schema_name: &str, table: &Table) -> String {
    let mut s = String::with_capacity(64 + table.columns.len() * 32);
    s.push_str(schema_name);
    s.push('.');
    s.push_str(&table.name);
    if !table.columns.is_empty() {
        s.push_str(". Columns: ");
        for (i, c) in table.columns.iter().enumerate() {
            if i > 0 {
                s.push_str(", ");
            }
            s.push_str(&c.name);
            s.push_str(": ");
            s.push_str(&c.data_type);
        }
    }
    s
}

pub fn qualified_name(schema_name: &str, table_name: &str) -> String {
    format!("{schema_name}.{table_name}")
}

/// Retrieve a filtered SchemaModel containing only tables likely relevant
/// to `question`. Caller checks `total_table_count(model) >= RETRIEVAL_THRESHOLD`
/// before invoking; this function does not enforce the threshold.
pub fn retrieve_relevant_schema(
    model: &SchemaModel,
    embeddings: &[StoredEmbedding],
    question_vec: &[f32],
) -> SchemaModel {
    let scored = score(question_vec, embeddings);
    let top: Vec<&str> = scored
        .iter()
        .take(RETRIEVAL_TOP_N)
        .map(|(name, _)| name.as_str())
        .collect();
    let mut keep: HashSet<String> = top.iter().map(|s| s.to_string()).collect();
    expand_fk_neighborhood(model, &mut keep);
    filter_schema(model, &keep)
}

/// Brute-force cosine similarity. O(N) — fine for the table counts we expect
/// in v1 (hundreds at most).
fn score(question: &[f32], embeddings: &[StoredEmbedding]) -> Vec<(String, f32)> {
    let q_norm = norm(question);
    let mut scored: Vec<(String, f32)> = embeddings
        .iter()
        .filter_map(|e| {
            if e.embedding.len() != question.len() {
                // Skip mismatched dimensions silently — likely from a
                // model change. UI prompts the user to re-embed in this case.
                return None;
            }
            let dot: f32 = question
                .iter()
                .zip(e.embedding.iter())
                .map(|(a, b)| a * b)
                .sum();
            let denom = q_norm * norm(&e.embedding);
            let cos = if denom > 0.0 { dot / denom } else { 0.0 };
            Some((e.qualified_table.clone(), cos))
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
}

fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

/// Walk every FK on every table currently in `keep` and add the referenced
/// (and referencing) qualified names. One hop only — we don't recurse to
/// FKs of FKs in v1.
fn expand_fk_neighborhood(model: &SchemaModel, keep: &mut HashSet<String>) {
    let mut additions: Vec<String> = Vec::new();
    for db_schema in &model.schemas {
        for table in &db_schema.tables {
            let qn = qualified_name(&db_schema.name, &table.name);
            if keep.contains(&qn) {
                // Outgoing FKs.
                for fk in &table.foreign_keys {
                    additions.push(qualified_name(
                        &fk.references_schema,
                        &fk.references_table,
                    ));
                }
            } else {
                // Incoming FKs (this table FK-references one we're keeping).
                for fk in &table.foreign_keys {
                    let target = qualified_name(
                        &fk.references_schema,
                        &fk.references_table,
                    );
                    if keep.contains(&target) {
                        additions.push(qn.clone());
                    }
                }
            }
        }
    }
    keep.extend(additions);
}

fn filter_schema(model: &SchemaModel, keep: &HashSet<String>) -> SchemaModel {
    let schemas: Vec<DbSchema> = model
        .schemas
        .iter()
        .filter_map(|db_schema| {
            let tables: Vec<Table> = db_schema
                .tables
                .iter()
                .filter(|t| keep.contains(&qualified_name(&db_schema.name, &t.name)))
                .cloned()
                .collect();
            if tables.is_empty() {
                None
            } else {
                Some(DbSchema {
                    name: db_schema.name.clone(),
                    tables,
                })
            }
        })
        .collect();
    SchemaModel {
        dialect: model.dialect.clone(),
        schemas,
        extracted_at: model.extracted_at,
        source: model.source.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Column, Dialect, ExtractionSource, ForeignKey};

    fn col(name: &str) -> Column {
        Column {
            name: name.to_string(),
            data_type: "int".to_string(),
            nullable: false,
            default: None,
            user_annotation: None,
            sensitive: false,
        }
    }

    fn t(name: &str, cols: Vec<&str>, fks: Vec<(&str, &str, &str, &str)>) -> Table {
        Table {
            name: name.to_string(),
            columns: cols.into_iter().map(col).collect(),
            primary_key: vec!["id".to_string()],
            foreign_keys: fks
                .into_iter()
                .map(|(c, rs, rt, rc)| ForeignKey {
                    columns: vec![c.to_string()],
                    references_schema: rs.to_string(),
                    references_table: rt.to_string(),
                    references_columns: vec![rc.to_string()],
                })
                .collect(),
            user_annotation: None,
            excluded: false,
        }
    }

    fn synthetic_schema() -> SchemaModel {
        SchemaModel {
            dialect: Dialect::Postgres,
            schemas: vec![DbSchema {
                name: "public".to_string(),
                tables: vec![
                    t("users", vec!["id", "email"], vec![]),
                    t("orders", vec!["id", "user_id"], vec![("user_id", "public", "users", "id")]),
                    t("products", vec!["id", "name"], vec![]),
                    t(
                        "order_items",
                        vec!["id", "order_id", "product_id"],
                        vec![
                            ("order_id", "public", "orders", "id"),
                            ("product_id", "public", "products", "id"),
                        ],
                    ),
                    t("audit", vec!["id", "user_id"], vec![("user_id", "public", "users", "id")]),
                ],
            }],
            extracted_at: 0,
            source: ExtractionSource::Live {
                connection_id: "test".to_string(),
            },
        }
    }

    #[test]
    fn fk_expansion_pulls_referenced_tables() {
        let schema = synthetic_schema();
        let mut keep: HashSet<String> = ["public.orders".to_string()].into_iter().collect();
        expand_fk_neighborhood(&schema, &mut keep);
        assert!(keep.contains("public.users"), "should pull referenced parent");
    }

    #[test]
    fn fk_expansion_pulls_referencing_tables() {
        let schema = synthetic_schema();
        let mut keep: HashSet<String> = ["public.users".to_string()].into_iter().collect();
        expand_fk_neighborhood(&schema, &mut keep);
        assert!(keep.contains("public.orders"), "should pull child");
        assert!(keep.contains("public.audit"), "should pull other child");
    }

    #[test]
    fn filter_schema_drops_excluded_tables() {
        let schema = synthetic_schema();
        let keep: HashSet<String> = ["public.users".to_string(), "public.orders".to_string()]
            .into_iter()
            .collect();
        let filtered = filter_schema(&schema, &keep);
        let names: Vec<&str> = filtered
            .schemas
            .iter()
            .flat_map(|s| s.tables.iter().map(|t| t.name.as_str()))
            .collect();
        assert_eq!(names, vec!["users", "orders"]);
    }
}
