// Phase 9: generate the security review pack as a PDF.
//
// The PDF is composed entirely from values already on the user's machine —
// nothing is fetched. It is intended for handoff to a security or compliance
// reviewer who wants a single artifact summarizing what the app does, what
// is configured, and what endpoints it contacts.
//
// Embedded content (constants below) reproduces the load-bearing parts of
// docs/SECURITY_MODEL.md and the verbatim extraction queries from
// docs/architecture/schema-extraction.md so the PDF is self-contained.
// Hand-edited summaries — they need to stay in sync with those source docs;
// CLAUDE.md flags this kind of duplication and the source docs are still
// the source of truth.

use std::io::BufWriter;

use printpdf::{
    BuiltinFont, IndirectFontRef, Mm, PdfDocument, PdfDocumentReference,
    PdfLayerIndex, PdfLayerReference, PdfPageIndex,
};

use crate::schema::SchemaModel;
use crate::store::{Annotation, ConnectionProfile, ProviderConfig, Redaction};

const PAGE_WIDTH_MM: f32 = 210.0; // A4
const PAGE_HEIGHT_MM: f32 = 297.0;
const MARGIN_MM: f32 = 18.0;
const LINE_HEIGHT_MM: f32 = 4.6; // body
const HEADING_HEIGHT_MM: f32 = 7.0;
const BODY_FONT_SIZE: f32 = 10.0;
const HEADING_FONT_SIZE: f32 = 14.0;
const BODY_WIDTH_CHARS: usize = 95; // wraps body text at this width

pub struct PdfInputs<'a> {
    pub app_version: &'a str,
    pub generated_at_iso: &'a str,
    pub profile: Option<&'a ConnectionProfile>,
    pub provider: Option<&'a ProviderConfig>,
    pub schema: Option<&'a SchemaModel>,
    pub annotations: &'a [Annotation],
    pub redactions: &'a [Redaction],
    pub telemetry_enabled: bool,
}

pub fn build_security_pdf(inputs: &PdfInputs<'_>) -> Result<Vec<u8>, String> {
    let (doc, first_page, first_layer) = PdfDocument::new(
        "SQL Mate — Security Review Pack",
        Mm(PAGE_WIDTH_MM),
        Mm(PAGE_HEIGHT_MM),
        "Page 1",
    );
    let body = doc
        .add_builtin_font(BuiltinFont::Helvetica)
        .map_err(|e| format!("font: {e}"))?;
    let bold = doc
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .map_err(|e| format!("font: {e}"))?;
    let mono = doc
        .add_builtin_font(BuiltinFont::Courier)
        .map_err(|e| format!("font: {e}"))?;

    let mut pb = PageBuilder {
        doc,
        pages: vec![(first_page, first_layer)],
        current: 0,
        y_top_down_mm: MARGIN_MM,
        body,
        bold,
        mono,
    };

    write_title(&mut pb, inputs);
    pb.skip(6.0);
    write_security_guarantees(&mut pb);
    pb.new_page();
    write_current_configuration(&mut pb, inputs);
    pb.new_page();
    write_network_endpoints(&mut pb, inputs);
    pb.new_page();
    write_extraction_queries(&mut pb);

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = BufWriter::new(&mut buf);
        pb.doc.save(&mut writer).map_err(|e| format!("save: {e}"))?;
    }
    Ok(buf)
}

// ---------------- page composition helpers ----------------

struct PageBuilder {
    doc: PdfDocumentReference,
    pages: Vec<(PdfPageIndex, PdfLayerIndex)>,
    current: usize,
    /// Distance from the top of the page in mm — easier to reason about than
    /// printpdf's bottom-up coordinate system.
    y_top_down_mm: f32,
    body: IndirectFontRef,
    bold: IndirectFontRef,
    mono: IndirectFontRef,
}

impl PageBuilder {
    fn current_layer(&self) -> PdfLayerReference {
        let (page_idx, layer_idx) = self.pages[self.current];
        self.doc.get_page(page_idx).get_layer(layer_idx)
    }

    fn new_page(&mut self) {
        let (p, l) = self.doc.add_page(
            Mm(PAGE_WIDTH_MM),
            Mm(PAGE_HEIGHT_MM),
            format!("Page {}", self.pages.len() + 1),
        );
        self.pages.push((p, l));
        self.current = self.pages.len() - 1;
        self.y_top_down_mm = MARGIN_MM;
    }

    fn ensure_space(&mut self, needed_mm: f32) {
        if self.y_top_down_mm + needed_mm > PAGE_HEIGHT_MM - MARGIN_MM {
            self.new_page();
        }
    }

    fn skip(&mut self, mm: f32) {
        self.y_top_down_mm += mm;
    }

    fn heading(&mut self, text: &str) {
        self.ensure_space(HEADING_HEIGHT_MM + 2.0);
        let y_from_bottom = PAGE_HEIGHT_MM - self.y_top_down_mm - HEADING_HEIGHT_MM;
        let layer = self.current_layer();
        layer.use_text(
            text,
            HEADING_FONT_SIZE,
            Mm(MARGIN_MM),
            Mm(y_from_bottom),
            &self.bold,
        );
        self.y_top_down_mm += HEADING_HEIGHT_MM + 2.0;
    }

    fn body_line(&mut self, text: &str) {
        self.ensure_space(LINE_HEIGHT_MM);
        let y_from_bottom = PAGE_HEIGHT_MM - self.y_top_down_mm - LINE_HEIGHT_MM;
        let layer = self.current_layer();
        layer.use_text(
            text,
            BODY_FONT_SIZE,
            Mm(MARGIN_MM),
            Mm(y_from_bottom),
            &self.body,
        );
        self.y_top_down_mm += LINE_HEIGHT_MM;
    }

    fn bold_line(&mut self, text: &str) {
        self.ensure_space(LINE_HEIGHT_MM);
        let y_from_bottom = PAGE_HEIGHT_MM - self.y_top_down_mm - LINE_HEIGHT_MM;
        let layer = self.current_layer();
        layer.use_text(
            text,
            BODY_FONT_SIZE,
            Mm(MARGIN_MM),
            Mm(y_from_bottom),
            &self.bold,
        );
        self.y_top_down_mm += LINE_HEIGHT_MM;
    }

    fn mono_line(&mut self, text: &str) {
        self.ensure_space(LINE_HEIGHT_MM);
        let y_from_bottom = PAGE_HEIGHT_MM - self.y_top_down_mm - LINE_HEIGHT_MM;
        let layer = self.current_layer();
        layer.use_text(
            text,
            BODY_FONT_SIZE - 1.0,
            Mm(MARGIN_MM),
            Mm(y_from_bottom),
            &self.mono,
        );
        self.y_top_down_mm += LINE_HEIGHT_MM;
    }

    fn paragraph(&mut self, text: &str) {
        for line in wrap_text(text, BODY_WIDTH_CHARS) {
            self.body_line(&line);
        }
    }

    fn paragraph_indent(&mut self, text: &str, indent_chars: usize) {
        let prefix = " ".repeat(indent_chars);
        let wrap_width = BODY_WIDTH_CHARS.saturating_sub(indent_chars);
        for (i, line) in wrap_text(text, wrap_width).into_iter().enumerate() {
            if i == 0 {
                self.body_line(&line);
            } else {
                self.body_line(&format!("{prefix}{line}"));
            }
        }
    }
}

fn wrap_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut out = Vec::new();
    for raw_line in text.split('\n') {
        if raw_line.len() <= max_chars {
            out.push(raw_line.to_string());
            continue;
        }
        let mut current = String::new();
        for word in raw_line.split_whitespace() {
            if current.is_empty() {
                current.push_str(word);
            } else if current.len() + 1 + word.len() <= max_chars {
                current.push(' ');
                current.push_str(word);
            } else {
                out.push(std::mem::take(&mut current));
                current.push_str(word);
            }
        }
        if !current.is_empty() {
            out.push(current);
        }
    }
    out
}

// ---------------- content sections ----------------

fn write_title(pb: &mut PageBuilder, inputs: &PdfInputs<'_>) {
    pb.heading("SQL Mate — Security Review Pack");
    pb.body_line(&format!("Generated: {}", inputs.generated_at_iso));
    pb.body_line(&format!("App version: {}", inputs.app_version));
    pb.skip(2.0);
    pb.paragraph(
        "This document summarizes what this app does, what is configured \
         on this user's installation, and what network endpoints it \
         contacts. It is intended for review by a security or compliance \
         team. Every value below comes from the local installation; \
         nothing was fetched to produce this PDF.",
    );
}

const SECURITY_GUARANTEES: &str = "\
1. Row data from your database never leaves your machine. Not to the LLM \
   provider, not to us, not to anywhere. The LLM call path receives only \
   schema metadata (table and column names, types, keys, user-written \
   descriptions). Query results are displayed locally and stored locally, \
   never transmitted.

2. We are not in the data path. The application makes its LLM calls \
   directly from your machine to the provider you configured, using the \
   API key you provided. We do not proxy. We do not have a server.

3. Generated SQL is read-only by construction. Every query is parsed and \
   validated for read-only operations before you see it. The validator \
   rejects any query that mutates state. Enforced at the application \
   layer; you should additionally use database credentials that are \
   read-only at the database layer.

4. You see every query before it runs. The query is displayed in the UI \
   with an explanation of what it does, and you click run. There is no \
   auto-execute path.

5. Your API keys and database passwords are stored encrypted at rest. \
   Secrets live in a SQLCipher-encrypted local SQLite file (AES-256-CBC, \
   key in a sibling file under the app data directory). The original \
   spec called for the OS keychain (macOS Keychain, Windows Credential \
   Manager, Linux Secret Service); that integration is deferred and \
   tracked in ADR 0008.

6. No telemetry by default. If you opt in, telemetry would contain only \
   anonymous usage counts and never schema names, query text, or any \
   database content. As of this build, the app does not transmit \
   telemetry whether the toggle is on or off — the toggle is a UI \
   placeholder for the future telemetry pipeline.";

const NOT_GUARANTEED: &str = "\
- The LLM provider's data handling. What Anthropic, OpenAI, or any other \
  provider does with the schema metadata you send them is governed by \
  their terms, not ours. We surface their published retention policies in \
  the UI to help you choose.

- Protection from a compromised local machine. If an attacker has code \
  execution on your machine, they can read the SQLCipher store, the key \
  file, and your database connection regardless of what we do.

- Schema name confidentiality by default. Table and column names go into \
  the LLM request unless you explicitly mark them excluded or sensitive. \
  Use the redaction layer for names that themselves reveal sensitive \
  information.";

fn write_security_guarantees(pb: &mut PageBuilder) {
    pb.heading("Security guarantees");
    pb.paragraph(SECURITY_GUARANTEES);
    pb.skip(3.0);
    pb.heading("What is explicitly not guaranteed");
    pb.paragraph(NOT_GUARANTEED);
}

fn write_current_configuration(pb: &mut PageBuilder, inputs: &PdfInputs<'_>) {
    pb.heading("Current configuration");

    pb.bold_line("Database connection");
    match inputs.profile {
        Some(p) => {
            pb.body_line(&format!("Name: {}", p.name));
            pb.body_line(&format!("Dialect: {}", p.dialect));
            pb.body_line(&format!("Host: {}:{}", p.host, p.port));
            pb.body_line(&format!("Database: {}", p.database_name));
            pb.body_line(&format!("Username: {}", p.username));
            pb.body_line("Password: [stored encrypted in SQLCipher local store; not included]");
        }
        None => pb.body_line("(no connection profile selected)"),
    }
    pb.skip(2.0);

    pb.bold_line("LLM provider");
    match inputs.provider {
        Some(pc) => {
            pb.body_line(&format!("Name: {}", pc.name));
            pb.body_line(&format!("Kind: {}", pc.kind));
            pb.body_line(&format!("Base URL: {}", pc.base_url));
            pb.body_line(&format!("Model: {}", pc.model));
            pb.body_line("API key: [stored encrypted in SQLCipher local store; not included]");
        }
        None => pb.body_line("(no LLM provider configured)"),
    }
    pb.skip(2.0);

    pb.bold_line("Schema visibility (Phase 8 redaction state)");
    if let Some(model) = inputs.schema {
        let total_tables: usize = model.schemas.iter().map(|s| s.tables.len()).sum();
        let excluded: Vec<String> = model
            .schemas
            .iter()
            .flat_map(|s| {
                s.tables
                    .iter()
                    .filter(|t| t.excluded)
                    .map(move |t| format!("{}.{}", s.name, t.name))
            })
            .collect();
        let sensitive: Vec<String> = model
            .schemas
            .iter()
            .flat_map(|s| {
                s.tables.iter().flat_map(move |t| {
                    t.columns.iter().filter(|c| c.sensitive).map(move |c| {
                        format!("{}.{}.{}", s.name, t.name, c.name)
                    })
                })
            })
            .collect();
        pb.body_line(&format!(
            "Tables visible: {}; excluded: {}; sensitive columns: {}.",
            total_tables - excluded.len(),
            excluded.len(),
            sensitive.len()
        ));
        if !excluded.is_empty() {
            pb.body_line("Excluded tables (omitted entirely from the LLM prompt):");
            for t in &excluded {
                pb.body_line(&format!("  - {t}"));
            }
        }
        if !sensitive.is_empty() {
            pb.body_line(
                "Sensitive columns (sent with placeholder names, de-obfuscated locally):",
            );
            for c in &sensitive {
                pb.body_line(&format!("  - {c}"));
            }
        }
    } else {
        pb.body_line("(no schema extracted yet)");
    }
    pb.skip(2.0);

    pb.bold_line("User annotations on schema entities");
    if inputs.annotations.is_empty() {
        pb.body_line("(none)");
    } else {
        for a in inputs.annotations {
            let target = match &a.column_name {
                None => format!("{}.{}", a.schema_name, a.table_name),
                Some(c) => format!("{}.{}.{}", a.schema_name, a.table_name, c),
            };
            pb.body_line(&format!("- {target}:"));
            pb.paragraph_indent(&a.annotation, 4);
        }
    }
    pb.skip(2.0);

    let _ = inputs.redactions; // counts already shown above; raw rows not surfaced

    pb.bold_line("Telemetry");
    pb.body_line(&format!(
        "Opt-in toggle: {}",
        if inputs.telemetry_enabled {
            "ON (no payload sent in this build — placeholder for future telemetry pipeline)"
        } else {
            "OFF (default; nothing is sent)"
        }
    ));
}

fn write_network_endpoints(pb: &mut PageBuilder, inputs: &PdfInputs<'_>) {
    pb.heading("Network endpoints this app may contact");
    pb.paragraph(
        "Every URL the app talks to is listed below, with a one-line \
         purpose. A reviewer can verify these by inspecting outbound \
         traffic with a proxy.",
    );
    pb.skip(2.0);

    pb.bold_line("LLM provider (per request, when you click Generate SQL)");
    match inputs.provider {
        Some(pc) => pb.body_line(&format!("- {}", pc.base_url)),
        None => pb.body_line("- (none — no provider configured)"),
    }
    pb.body_line("  Sends: system prompt, schema metadata, your question.");
    pb.body_line("  Does not send: row data, API keys to anyone but the provider.");
    pb.skip(2.0);

    pb.bold_line("Database (per query, when you click Run)");
    match inputs.profile {
        Some(p) => pb.body_line(&format!("- {}:{} (database '{}')", p.host, p.port, p.database_name)),
        None => pb.body_line("- (none — no connection configured)"),
    }
    pb.body_line("  Sends: the validated SELECT query produced by the LLM.");
    pb.body_line("  Receives: rows, displayed locally, never re-transmitted.");
    pb.skip(2.0);

    pb.bold_line("Model registry");
    pb.body_line("- Bundled with the app (no remote fetch in v1).");
    pb.skip(2.0);

    pb.bold_line("Telemetry");
    pb.body_line("- (no endpoint in this build)");
    pb.skip(2.0);

    pb.bold_line("Update server");
    pb.body_line("- (no auto-update in v1)");
}

const PG_EXTRACTION_QUERY: &str = r#"
SELECT
  c.table_schema,
  c.table_name,
  c.column_name,
  c.ordinal_position,
  c.data_type,
  c.is_nullable,
  c.column_default,
  CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key,
  fk.foreign_table_schema,
  fk.foreign_table_name,
  fk.foreign_column_name
FROM information_schema.columns c
LEFT JOIN (
  SELECT kcu.table_schema, kcu.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
) pk
  ON c.table_schema = pk.table_schema
 AND c.table_name = pk.table_name
 AND c.column_name = pk.column_name
LEFT JOIN (
  SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
         ccu.table_schema AS foreign_table_schema,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
) fk
  ON c.table_schema = fk.table_schema
 AND c.table_name = fk.table_name
 AND c.column_name = fk.column_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position
"#;

const MYSQL_EXTRACTION_QUERY: &str = r#"
SELECT
  c.TABLE_SCHEMA AS table_schema,
  c.TABLE_NAME AS table_name,
  c.COLUMN_NAME AS column_name,
  c.ORDINAL_POSITION AS ordinal_position,
  c.DATA_TYPE AS data_type,
  c.IS_NULLABLE AS is_nullable,
  c.COLUMN_DEFAULT AS column_default,
  CASE WHEN c.COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END AS is_primary_key,
  kcu.REFERENCED_TABLE_SCHEMA AS foreign_table_schema,
  kcu.REFERENCED_TABLE_NAME AS foreign_table_name,
  kcu.REFERENCED_COLUMN_NAME AS foreign_column_name
FROM information_schema.COLUMNS c
LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA
 AND c.TABLE_NAME = kcu.TABLE_NAME
 AND c.COLUMN_NAME = kcu.COLUMN_NAME
 AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
WHERE c.TABLE_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
"#;

fn write_extraction_queries(pb: &mut PageBuilder) {
    pb.heading("Schema extraction queries (verbatim)");
    pb.paragraph(
        "These are the only queries this app issues against your database \
         metadata. They read from information_schema only and never touch \
         user data tables. A DBA can re-run them in a read-only console to \
         confirm what the app would see.",
    );
    pb.skip(3.0);

    pb.bold_line("Postgres");
    for line in PG_EXTRACTION_QUERY.lines() {
        pb.mono_line(line);
    }
    pb.skip(3.0);

    pb.bold_line("MySQL / MariaDB");
    for line in MYSQL_EXTRACTION_QUERY.lines() {
        pb.mono_line(line);
    }
}
