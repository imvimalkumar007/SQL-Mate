import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { Onboarding } from "./Onboarding";
import type {
  ConnectionProfile,
  EmbeddingStats,
  ExecutionResult,
  GenerationResult,
  ModelRegistry,
  ProviderConfig,
  ProviderKind,
  RequestLogEntry,
  SchemaModel,
  ValidatedSql,
} from "./types";

type Validation =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; referenced: string[] }
  | { state: "error"; message: string };

type DbDialect = "postgres" | "mysql" | "sqlite" | "mssql";

const DIALECT_OPTIONS: Array<{
  value: DbDialect;
  label: string;
  default_port: string;
  enabled: boolean;
  note?: string;
}> = [
  { value: "postgres", label: "PostgreSQL",       default_port: "5432", enabled: true },
  { value: "mysql",    label: "MySQL / MariaDB",  default_port: "3306", enabled: true },
  { value: "sqlite",   label: "SQLite (deferred)", default_port: "",    enabled: false, note: "see PHASE_6_LOG.md" },
  { value: "mssql",    label: "SQL Server (deferred)", default_port: "1433", enabled: false, note: "see PHASE_6_LOG.md" },
];

type NewProfileForm = {
  name: string;
  dialect: DbDialect;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
};

const EMPTY_FORM: NewProfileForm = {
  name: "",
  dialect: "postgres",
  host: "localhost",
  port: "5432",
  database: "",
  username: "",
  password: "",
};

type NewProviderForm = {
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
  api_key: string;
};

function defaultProviderForm(reg: ModelRegistry | null): NewProviderForm {
  const first = reg?.providers[0];
  return {
    name: first?.name ?? "",
    kind: first?.kind ?? "anthropic",
    base_url: first?.default_base_url ?? "",
    model: first?.models[0]?.id ?? "",
    api_key: "",
  };
}

function App() {
  // LLM provider configuration
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [registry, setRegistry] = useState<ModelRegistry | null>(null);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [providerForm, setProviderForm] = useState<NewProviderForm>(
    defaultProviderForm(null)
  );
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  // Profiles
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Add-profile form
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<NewProfileForm>(EMPTY_FORM);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [formBusy, setFormBusy] = useState(false);

  // Schema for selected profile
  const [schema, setSchema] = useState<SchemaModel | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  // Generation
  const [question, setQuestion] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedSql, setGeneratedSql] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [generatedByModel, setGeneratedByModel] = useState<string | null>(null);

  // Model picker (Phase 7 / ADR 0013)
  const [pickerOpen, setPickerOpen] = useState(false);

  // Validation
  const [validation, setValidation] = useState<Validation>({ state: "idle" });

  // Execution
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [results, setResults] = useState<ExecutionResult | null>(null);

  // Embeddings
  const [embeddingStats, setEmbeddingStats] = useState<EmbeddingStats | null>(null);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);

  // Annotations + redactions (Phase 8)
  type EditingTarget = { schemaName: string; tableName: string; columnName: string | null };
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [requestLog, setRequestLog] = useState<RequestLogEntry | null>(null);

  // Phase 9: onboarding gate + settings
  const [onboardingActive, setOnboardingActive] = useState<boolean | null>(null);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<{ path: string; bytes: number } | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<boolean>("get_onboarding_completed").then((done) => {
      setOnboardingActive(!done);
    });
    void invoke<boolean>("get_telemetry_enabled").then(setTelemetryEnabled);
    void refreshProviders();
    void invoke<ModelRegistry>("get_model_registry").then((r) => {
      setRegistry(r);
      setProviderForm(defaultProviderForm(r));
    });
    void refreshProfiles();
  }, []);

  useEffect(() => {
    setSchema(null);
    setExtractError(null);
    setGeneratedSql(null);
    setGenerateError(null);
    setEmbeddingStats(null);
    setEmbeddingError(null);
    setRequestLog(null);
    setEditing(null);
    if (!selectedId) return;
    void invoke<SchemaModel | null>("get_persisted_schema", { connectionId: selectedId })
      .then(setSchema)
      .catch((e) => setExtractError(String(e)));
    void refreshEmbeddingStats(selectedId);
  }, [selectedId]);

  async function refreshProfiles() {
    const list = await invoke<ConnectionProfile[]>("list_connection_profiles");
    setProfiles(list);
  }

  async function refreshProviders() {
    const list = await invoke<ProviderConfig[]>("list_provider_configs");
    setProviders(list);
    const active = await invoke<ProviderConfig | null>("get_active_provider");
    setActiveProviderId(active ? active.id : null);
  }

  function setRegistryDefaultsForKind(kind: ProviderKind, current: NewProviderForm): NewProviderForm {
    const reg = registry?.providers.find((p) => p.kind === kind);
    return {
      ...current,
      kind,
      base_url: reg?.default_base_url ?? current.base_url,
      model: reg?.models[0]?.id ?? current.model,
      name: current.name || reg?.name || "",
    };
  }

  async function saveProvider() {
    setProviderBusy(true);
    setProviderError(null);
    try {
      const created = await invoke<ProviderConfig>("create_provider_config", {
        req: {
          name: providerForm.name || providerForm.kind,
          kind: providerForm.kind,
          base_url: providerForm.base_url,
          model: providerForm.model,
          api_key: providerForm.api_key,
        },
      });
      await refreshProviders();
      // The backend auto-selects the first config as active; if a config
      // existed already, the new one is just added — leave active alone.
      void created;
      setShowAddProvider(false);
      setProviderForm(defaultProviderForm(registry));
    } catch (e) {
      setProviderError(String(e));
    } finally {
      setProviderBusy(false);
    }
  }

  async function deleteProvider(id: string) {
    if (!confirm("Delete this provider config? The API key is wiped from the encrypted store.")) return;
    await invoke("delete_provider_config", { id });
    await refreshProviders();
  }

  async function setActive(id: string) {
    await invoke("set_active_provider", { id });
    setActiveProviderId(id);
  }

  async function switchToModel(providerId: string, modelId: string) {
    if (providerId !== activeProviderId) {
      await invoke("set_active_provider", { id: providerId });
      setActiveProviderId(providerId);
    }
    await invoke("update_provider_model", { id: providerId, model: modelId });
    await refreshProviders();
    setPickerOpen(false);
  }

  async function refreshEmbeddingStats(connectionId: string) {
    try {
      const s = await invoke<EmbeddingStats>("get_embedding_stats", {
        connectionId,
      });
      setEmbeddingStats(s);
    } catch (e) {
      setEmbeddingError(String(e));
    }
  }

  async function generateEmbeddings() {
    if (!selectedId) return;
    setEmbeddingBusy(true);
    setEmbeddingError(null);
    try {
      const s = await invoke<EmbeddingStats>("embed_schema", {
        connectionId: selectedId,
      });
      setEmbeddingStats(s);
    } catch (e) {
      setEmbeddingError(String(e));
    } finally {
      setEmbeddingBusy(false);
    }
  }

  async function clearEmbeddings() {
    if (!selectedId) return;
    if (!confirm("Clear all stored embeddings for this connection?")) return;
    setEmbeddingBusy(true);
    try {
      await invoke("clear_schema_embeddings", { connectionId: selectedId });
      await refreshEmbeddingStats(selectedId);
    } finally {
      setEmbeddingBusy(false);
    }
  }

  // Phase 8: redaction + annotation helpers.
  async function reloadSchema() {
    if (!selectedId) return;
    const fresh = await invoke<SchemaModel | null>("get_persisted_schema", {
      connectionId: selectedId,
    });
    setSchema(fresh);
  }

  async function toggleExcluded(schemaName: string, tableName: string, currently: boolean) {
    if (!selectedId) return;
    if (currently) {
      await invoke("clear_redaction", {
        req: { connection_id: selectedId, schema_name: schemaName, table_name: tableName, column_name: null },
      });
    } else {
      await invoke("set_redaction", {
        req: { connection_id: selectedId, schema_name: schemaName, table_name: tableName, column_name: null, kind: "excluded" },
      });
    }
    await reloadSchema();
  }

  async function toggleSensitive(
    schemaName: string,
    tableName: string,
    columnName: string,
    currently: boolean,
  ) {
    if (!selectedId) return;
    if (currently) {
      await invoke("clear_redaction", {
        req: { connection_id: selectedId, schema_name: schemaName, table_name: tableName, column_name: columnName },
      });
    } else {
      await invoke("set_redaction", {
        req: { connection_id: selectedId, schema_name: schemaName, table_name: tableName, column_name: columnName, kind: "sensitive" },
      });
    }
    await reloadSchema();
  }

  function startAnnotating(target: EditingTarget, current: string | null) {
    setEditing(target);
    setAnnotationDraft(current ?? "");
  }

  async function saveAnnotation() {
    if (!selectedId || !editing) return;
    const trimmed = annotationDraft.trim();
    if (trimmed === "") {
      await invoke("clear_annotation", {
        req: {
          connection_id: selectedId,
          schema_name: editing.schemaName,
          table_name: editing.tableName,
          column_name: editing.columnName,
        },
      });
    } else {
      await invoke("set_annotation", {
        req: {
          connection_id: selectedId,
          schema_name: editing.schemaName,
          table_name: editing.tableName,
          column_name: editing.columnName,
          annotation: trimmed,
        },
      });
    }
    setEditing(null);
    setAnnotationDraft("");
    await reloadSchema();
  }

  async function refreshRequestLog(connectionId: string) {
    try {
      const entry = await invoke<RequestLogEntry | null>("get_last_request_log", {
        connectionId,
      });
      setRequestLog(entry);
    } catch {
      setRequestLog(null);
    }
  }

  // Phase 9 settings handlers.
  async function toggleTelemetry() {
    const next = !telemetryEnabled;
    await invoke("set_telemetry_enabled", { enabled: next });
    setTelemetryEnabled(next);
  }

  async function exportSecurityPdf() {
    setPdfBusy(true);
    setPdfError(null);
    setPdfStatus(null);
    try {
      const result = await invoke<{ path: string; byte_count: number }>(
        "export_security_pdf",
        { connectionId: selectedId },
      );
      setPdfStatus({ path: result.path, bytes: result.byte_count });
    } catch (e) {
      setPdfError(String(e));
    } finally {
      setPdfBusy(false);
    }
  }

  async function testConnection() {
    setFormBusy(true);
    setTestStatus(null);
    try {
      const port = parseInt(form.port, 10);
      if (Number.isNaN(port)) throw new Error("port must be a number");
      await invoke("test_connection", {
        req: {
          dialect: form.dialect,
          host: form.host,
          port,
          database: form.database,
          username: form.username,
          password: form.password,
        },
      });
      setTestStatus({ ok: true, msg: "Connection OK." });
    } catch (e) {
      setTestStatus({ ok: false, msg: String(e) });
    } finally {
      setFormBusy(false);
    }
  }

  async function saveProfile() {
    setFormBusy(true);
    try {
      const port = parseInt(form.port, 10);
      if (Number.isNaN(port)) throw new Error("port must be a number");
      const created = await invoke<ConnectionProfile>("create_connection_profile", {
        req: {
          name: form.name || `${form.host}:${port}/${form.database}`,
          dialect: form.dialect,
          host: form.host,
          port,
          database: form.database,
          username: form.username,
          password: form.password,
        },
      });
      await refreshProfiles();
      setSelectedId(created.id);
      setShowAddForm(false);
      setForm(EMPTY_FORM);
      setTestStatus(null);
    } catch (e) {
      setTestStatus({ ok: false, msg: String(e) });
    } finally {
      setFormBusy(false);
    }
  }

  async function deleteProfile(id: string) {
    if (!confirm("Delete this connection profile? The saved password is removed from the keychain.")) return;
    await invoke("delete_connection_profile", { id });
    if (selectedId === id) setSelectedId(null);
    await refreshProfiles();
  }

  async function extractSchema() {
    if (!selectedId) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const m = await invoke<SchemaModel>("extract_schema", { connectionId: selectedId });
      setSchema(m);
    } catch (e) {
      setExtractError(String(e));
    } finally {
      setExtracting(false);
    }
  }

  async function generate() {
    if (!selectedId || !question.trim()) return;
    setGenerating(true);
    setGeneratedSql(null);
    setGenerateError(null);
    setHistoryId(null);
    setGeneratedByModel(null);
    setValidation({ state: "idle" });
    setResults(null);
    setExecuteError(null);
    try {
      const result = await invoke<GenerationResult>("generate_sql", {
        connectionId: selectedId,
        question,
      });
      setGeneratedSql(result.sql);
      setHistoryId(result.history_id);
      setGeneratedByModel(result.model);
      void refreshRequestLog(selectedId);
      void validate(result.sql, result.history_id);
    } catch (e) {
      setGenerateError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function validate(sql: string, hid: string | null = historyId) {
    if (!selectedId) return;
    setValidation({ state: "running" });
    try {
      const v = await invoke<ValidatedSql>("validate_sql", {
        connectionId: selectedId,
        sql,
        historyId: hid,
      });
      setValidation({ state: "ok", referenced: v.referenced_tables });
    } catch (e) {
      setValidation({ state: "error", message: String(e) });
    }
  }

  async function runQuery() {
    if (!selectedId || !generatedSql) return;
    setExecuting(true);
    setExecuteError(null);
    setResults(null);
    try {
      const r = await invoke<ExecutionResult>("execute_query", {
        connectionId: selectedId,
        sql: generatedSql,
        historyId,
      });
      setResults(r);
    } catch (e) {
      setExecuteError(String(e));
    } finally {
      setExecuting(false);
    }
  }

  const selectedProfile = profiles.find((p) => p.id === selectedId) ?? null;
  const tableCount = schema
    ? schema.schemas.reduce((acc, s) => acc + s.tables.length, 0)
    : 0;

  if (onboardingActive === null) {
    return null;
  }
  if (onboardingActive) {
    return (
      <Onboarding
        registry={registry}
        onComplete={() => {
          setOnboardingActive(false);
          void refreshProviders();
          void refreshProfiles();
        }}
      />
    );
  }

  return (
    <main className="container">
      <h1>SQL Mate</h1>
      <p className="subtitle">
        Local-first natural-language SQL. Row data never leaves this machine.
        See the security review pack at the bottom of this page for the audit
        trail.
      </p>

      <section className="card">
        <div className="card-header">
          <h2>LLM provider</h2>
          {!showAddProvider && (
            <button onClick={() => setShowAddProvider(true)} className="secondary">
              Add provider
            </button>
          )}
        </div>

        {providers.length === 0 && !showAddProvider && (
          <p className="muted">
            No provider configured. Click "Add provider" to set one up.
          </p>
        )}

        {providers.length > 0 && (
          <div>
            <label>
              Active provider
              <select
                value={activeProviderId ?? ""}
                onChange={(e) => void setActive(e.currentTarget.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.kind} · {p.model}
                  </option>
                ))}
              </select>
            </label>
            <ul className="profile-list" style={{ marginTop: "0.5rem" }}>
              {providers.map((p) => (
                <li key={p.id} className={p.id === activeProviderId ? "selected" : ""}>
                  <span className="profile-row" style={{ cursor: "default" }}>
                    <span className="profile-name">{p.name}</span>
                    <span className="profile-detail">
                      {p.kind} · {p.model} · {p.base_url}
                    </span>
                  </span>
                  <button onClick={() => deleteProvider(p.id)} className="link-danger">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showAddProvider && registry && (
          <form
            className="profile-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveProvider();
            }}
          >
            <p className="muted small">
              The API key is stored inside the SQLCipher-encrypted local store. OS keychain integration is deferred — see ADR 0008.
            </p>
            <label>
              Provider
              <select
                value={providerForm.kind}
                onChange={(e) =>
                  setProviderForm((f) =>
                    setRegistryDefaultsForKind(e.currentTarget.value as ProviderKind, f)
                  )
                }
              >
                {registry.providers.map((p) => (
                  <option key={p.id} value={p.kind}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Friendly name
              <input
                value={providerForm.name}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, name: e.currentTarget.value })
                }
                placeholder="e.g. anthropic-prod"
              />
            </label>
            <label>
              Base URL
              <input
                value={providerForm.base_url}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, base_url: e.currentTarget.value })
                }
              />
            </label>
            <label>
              Model
              <select
                value={providerForm.model}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, model: e.currentTarget.value })
                }
              >
                {(
                  registry.providers.find((p) => p.kind === providerForm.kind)?.models ?? []
                ).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-..."
                value={providerForm.api_key}
                onChange={(e) =>
                  setProviderForm({ ...providerForm, api_key: e.currentTarget.value })
                }
                required
              />
            </label>
            {providerError && (
              <div className="status status-error">{providerError}</div>
            )}
            <div className="row">
              <button type="submit" disabled={providerBusy || !providerForm.api_key}>
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddProvider(false);
                  setProviderForm(defaultProviderForm(registry));
                  setProviderError(null);
                }}
                className="link"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2>Connections</h2>
          {!showAddForm && (
            <button onClick={() => setShowAddForm(true)} className="secondary">
              Add connection
            </button>
          )}
        </div>

        {profiles.length === 0 && !showAddForm && (
          <p className="muted">No connections yet. Click "Add connection" to set one up.</p>
        )}

        {profiles.length > 0 && (
          <ul className="profile-list">
            {profiles.map((p) => (
              <li key={p.id} className={p.id === selectedId ? "selected" : ""}>
                <button className="profile-row" onClick={() => setSelectedId(p.id)}>
                  <span className="profile-name">{p.name}</span>
                  <span className="profile-detail">
                    {p.dialect} · {p.host}:{p.port}/{p.database_name} · {p.username}
                  </span>
                </button>
                <button onClick={() => deleteProfile(p.id)} className="link-danger">
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {showAddForm && (
          <form
            className="profile-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveProfile();
            }}
          >
            <p className="muted small">
              Use a read-only role per <code>SECURITY_MODEL.md</code>. The password is stored
              inside the SQLCipher-encrypted local store (Phase 7 will revisit OS keychain
              integration). Phase 6 supports PostgreSQL and MySQL; SQLite and SQL Server are
              named deferrals — see PHASE_6_LOG.md.
            </p>
            <label>
              Dialect
              <select
                value={form.dialect}
                onChange={(e) => {
                  const d = e.currentTarget.value as DbDialect;
                  const opt = DIALECT_OPTIONS.find((o) => o.value === d);
                  setForm({
                    ...form,
                    dialect: d,
                    port: opt && opt.default_port ? opt.default_port : form.port,
                  });
                }}
              >
                {DIALECT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} disabled={!o.enabled}>
                    {o.label}
                    {o.note ? ` — ${o.note}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Friendly name
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
                placeholder="e.g. analytics-dev"
              />
            </label>
            <div className="row">
              <label className="grow">
                Host
                <input
                  required
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.currentTarget.value })}
                />
              </label>
              <label className="port">
                Port
                <input
                  required
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.currentTarget.value })}
                />
              </label>
            </div>
            <label>
              Database
              <input
                required
                value={form.database}
                onChange={(e) => setForm({ ...form, database: e.currentTarget.value })}
              />
            </label>
            <label>
              Username
              <input
                required
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.currentTarget.value })}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                required
                autoComplete="off"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
              />
            </label>
            {testStatus && (
              <div className={testStatus.ok ? "status status-ok" : "status status-error"}>
                {testStatus.msg}
              </div>
            )}
            <div className="row">
              <button type="button" onClick={testConnection} disabled={formBusy} className="secondary">
                Test connection
              </button>
              <button type="submit" disabled={formBusy}>
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(false);
                  setForm(EMPTY_FORM);
                  setTestStatus(null);
                }}
                className="link"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {selectedProfile && (
        <section className="card">
          <div className="card-header">
            <h2>Schema · {selectedProfile.name}</h2>
            <button onClick={extractSchema} disabled={extracting} className="secondary">
              {extracting ? "Extracting…" : schema ? "Re-extract" : "Extract schema"}
            </button>
          </div>
          {extractError && <div className="status status-error">{extractError}</div>}
          {!schema && !extractError && !extracting && (
            <p className="muted">No schema extracted yet for this connection.</p>
          )}
          {schema && (
            <>
              <p className="muted small">
                {schema.schemas.length} schema{schema.schemas.length === 1 ? "" : "s"},{" "}
                {tableCount} table{tableCount === 1 ? "" : "s"} · extracted{" "}
                {new Date(schema.extracted_at * 1000).toLocaleString()}
              </p>
              {embeddingStats && (
                <div className="row" style={{ margin: "0.5rem 0", flexWrap: "wrap" }}>
                  <span className="muted small">
                    Embeddings: {embeddingStats.embedded_count}/{embeddingStats.total_tables}
                    {embeddingStats.model && (
                      <>
                        {" "}· {embeddingStats.model}
                        {embeddingStats.embedded_at && (
                          <>
                            {" "}· {new Date(embeddingStats.embedded_at * 1000).toLocaleString()}
                          </>
                        )}
                      </>
                    )}
                    {embeddingStats.total_tables >= embeddingStats.retrieval_threshold && (
                      <>
                        {" "}· retrieval active (top-{embeddingStats.retrieval_top_n} + FK
                        neighborhood)
                      </>
                    )}
                  </span>
                  <button
                    onClick={generateEmbeddings}
                    disabled={embeddingBusy || !activeProviderId}
                    className="secondary"
                  >
                    {embeddingBusy
                      ? "Embedding…"
                      : embeddingStats.embedded_count > 0
                      ? "Re-generate embeddings"
                      : "Generate embeddings"}
                  </button>
                  {embeddingStats.embedded_count > 0 && (
                    <button onClick={clearEmbeddings} className="link-danger">
                      Clear
                    </button>
                  )}
                </div>
              )}
              {embeddingError && (
                <div className="status status-error">{embeddingError}</div>
              )}
              {(() => {
                const allTables = schema.schemas.flatMap((s) => s.tables);
                const excludedCount = allTables.filter((t) => t.excluded).length;
                const sensitiveCount = allTables
                  .flatMap((t) => t.columns)
                  .filter((c) => c.sensitive).length;
                return (
                  <div className="redaction-summary">
                    {allTables.length} table{allTables.length === 1 ? "" : "s"}
                    {", "}
                    {excludedCount} excluded
                    {", "}
                    {sensitiveCount} sensitive column{sensitiveCount === 1 ? "" : "s"}
                  </div>
                );
              })()}
              <div className="schema-tree">
                {schema.schemas.map((s) => (
                  <div key={s.name} className="schema-block">
                    <div className="schema-name">{s.name}</div>
                    {s.tables.map((t) => {
                      const editingThisTable =
                        editing?.schemaName === s.name &&
                        editing.tableName === t.name &&
                        editing.columnName === null;
                      return (
                      <details key={t.name} className={`table-block${t.excluded ? " excluded" : ""}`}>
                        <summary>
                          <span className="table-name">{t.name}</span>
                          <span className="muted small">
                            {" "}
                            ({t.columns.length} col{t.columns.length === 1 ? "" : "s"})
                          </span>
                          <span className="row-actions">
                            <button
                              type="button"
                              className={`toggle-chip danger${t.excluded ? " on" : ""}`}
                              onClick={(e) => {
                                e.preventDefault();
                                void toggleExcluded(s.name, t.name, t.excluded);
                              }}
                            >
                              {t.excluded ? "excluded" : "exclude"}
                            </button>
                            <button
                              type="button"
                              className="toggle-chip"
                              onClick={(e) => {
                                e.preventDefault();
                                startAnnotating({ schemaName: s.name, tableName: t.name, columnName: null }, t.user_annotation ?? null);
                              }}
                            >
                              {t.user_annotation ? "edit note" : "add note"}
                            </button>
                          </span>
                        </summary>
                        {t.user_annotation && !editingThisTable && (
                          <span className="annotation-text">— {t.user_annotation}</span>
                        )}
                        {editingThisTable && (
                          <div className="annotation-editor">
                            <textarea
                              rows={2}
                              value={annotationDraft}
                              onChange={(e) => setAnnotationDraft(e.currentTarget.value)}
                              placeholder="What is this table for? Notes are sent to the LLM as context."
                            />
                            <button type="button" onClick={() => void saveAnnotation()}>
                              Save
                            </button>
                            <button
                              type="button"
                              className="link"
                              onClick={() => {
                                setEditing(null);
                                setAnnotationDraft("");
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                        <ul className="column-list">
                          {t.columns.map((c) => {
                            const editingThisCol =
                              editing?.schemaName === s.name &&
                              editing.tableName === t.name &&
                              editing.columnName === c.name;
                            return (
                            <li key={c.name} className={c.sensitive ? "sensitive" : ""}>
                              <code>{c.name}</code>: {c.data_type}
                              {t.primary_key.includes(c.name) && (
                                <span className="badge">PK</span>
                              )}
                              {!c.nullable && <span className="badge">NOT NULL</span>}
                              {t.foreign_keys
                                .filter((fk) => fk.columns.includes(c.name))
                                .map((fk, i) => (
                                  <span key={i} className="badge">
                                    FK → {fk.references_schema}.{fk.references_table}.
                                    {fk.references_columns.join(",")}
                                  </span>
                                ))}
                              {c.sensitive && <span className="badge">sensitive</span>}
                              <span className="row-actions">
                                <button
                                  type="button"
                                  className={`toggle-chip${c.sensitive ? " on" : ""}`}
                                  onClick={() => void toggleSensitive(s.name, t.name, c.name, c.sensitive)}
                                >
                                  {c.sensitive ? "sensitive" : "mark sensitive"}
                                </button>
                                <button
                                  type="button"
                                  className="toggle-chip"
                                  onClick={() =>
                                    startAnnotating(
                                      { schemaName: s.name, tableName: t.name, columnName: c.name },
                                      c.user_annotation ?? null,
                                    )
                                  }
                                >
                                  {c.user_annotation ? "edit note" : "add note"}
                                </button>
                              </span>
                              {c.user_annotation && !editingThisCol && (
                                <span className="annotation-text">— {c.user_annotation}</span>
                              )}
                              {editingThisCol && (
                                <div className="annotation-editor">
                                  <textarea
                                    rows={2}
                                    value={annotationDraft}
                                    onChange={(e) => setAnnotationDraft(e.currentTarget.value)}
                                    placeholder="Notes about this column."
                                  />
                                  <button type="button" onClick={() => void saveAnnotation()}>
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    className="link"
                                    onClick={() => {
                                      setEditing(null);
                                      setAnnotationDraft("");
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </li>
                            );
                          })}
                        </ul>
                      </details>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {selectedProfile && schema && (
        <section className="card">
          <h2>Ask a question</h2>
          {(() => {
            const active = providers.find((p) => p.id === activeProviderId) ?? null;
            const regProvider = active && registry
              ? registry.providers.find((rp) => rp.kind === active.kind)
              : null;
            const activeModel = regProvider?.models.find((m) => m.id === active?.model) ?? null;
            const triggerLabel = active
              ? activeModel
                ? `${activeModel.name} · ${activeModel.cost_tier} cost`
                : `${active.name} · ${active.model}`
              : "No provider configured";
            return (
              <div className="model-picker">
                <button
                  type="button"
                  className="picker-trigger"
                  onClick={() => setPickerOpen((v) => !v)}
                  disabled={!active || providers.length === 0}
                >
                  <span>{triggerLabel}</span>
                  <span className="chevron">{pickerOpen ? "▴" : "▾"}</span>
                </button>
                {pickerOpen && registry && (
                  <div className="picker-dropdown">
                    {providers.map((p) => {
                      const rp = registry.providers.find((r) => r.kind === p.kind);
                      if (!rp) return null;
                      return (
                        <div key={p.id} className="picker-provider">
                          <div className="picker-provider-name">{p.name}</div>
                          {rp.models.map((m) => {
                            const isActive = p.id === activeProviderId && p.model === m.id;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                className={`picker-model${isActive ? " active" : ""}`}
                                onClick={() => void switchToModel(p.id, m.id)}
                              >
                                <span>{m.name}</span>
                                <span className={`cost-tier cost-${m.cost_tier}`}>
                                  {m.cost_tier}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
          >
            <textarea
              rows={3}
              placeholder="e.g. How many orders did each customer place last month?"
              value={question}
              onChange={(e) => setQuestion(e.currentTarget.value)}
            />
            <div className="row">
              <button
                type="submit"
                disabled={generating || !question.trim() || !activeProviderId}
              >
                {generating ? "Generating…" : "Generate SQL"}
              </button>
              {!activeProviderId && (
                <span className="muted small">Configure a provider above first.</span>
              )}
            </div>
          </form>
          {generateError && <div className="status status-error">{generateError}</div>}
          {generatedSql && (
            <>
              <div className="output">
                <div className="output-label">Generated SQL</div>
                <pre>{generatedSql}</pre>
              </div>
              {generatedByModel && (
                <div className="generated-by">
                  Generated by <code>{generatedByModel}</code>
                </div>
              )}

              {validation.state === "running" && (
                <div className="status">Validating with sqlglot…</div>
              )}
              {validation.state === "error" && (
                <div className="status status-error">
                  Validation failed: {validation.message}
                </div>
              )}
              {validation.state === "ok" && (
                <div className="status status-ok">
                  Validation passed. References:{" "}
                  {validation.referenced.length === 0
                    ? "(none)"
                    : validation.referenced.join(", ")}
                </div>
              )}

              {validation.state === "ok" && (
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  <button onClick={runQuery} disabled={executing}>
                    {executing ? "Running…" : "Run query"}
                  </button>
                  <span className="muted small">
                    Read-only transaction · cap {1000} rows · 30s timeout
                  </span>
                </div>
              )}

              {executeError && <div className="status status-error">{executeError}</div>}

              {results && (
                <div className="results">
                  <div className="results-meta muted small">
                    {results.row_count} row{results.row_count === 1 ? "" : "s"}
                    {results.truncated && " (truncated)"} · {results.duration_ms} ms
                  </div>
                  <div className="results-table-wrap">
                    <table className="results-table">
                      <thead>
                        <tr>
                          {results.columns.map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {results.rows.map((r, i) => (
                          <tr key={i}>
                            {r.map((cell, j) => (
                              <td key={j}>{cellRender(cell)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
          {requestLog && (
            <div className="request-log">
              <details>
                <summary>
                  Request log — what was sent to the model
                  {requestLog.obfuscated_columns > 0 &&
                    ` · ${requestLog.obfuscated_columns} sensitive column${requestLog.obfuscated_columns === 1 ? "" : "s"} obfuscated`}
                  {requestLog.excluded_tables.length > 0 &&
                    ` · ${requestLog.excluded_tables.length} table${requestLog.excluded_tables.length === 1 ? "" : "s"} excluded`}
                </summary>
                <div className="log-meta">
                  Sent to <code>{requestLog.model}</code> ({requestLog.provider_kind}) at{" "}
                  {new Date(requestLog.timestamp * 1000).toLocaleTimeString()}.
                  {requestLog.excluded_tables.length > 0 && (
                    <>
                      {" Excluded: "}
                      {requestLog.excluded_tables.map((t, i) => (
                        <code key={i} style={{ marginRight: "0.4rem" }}>
                          {t}
                        </code>
                      ))}
                    </>
                  )}
                </div>
                <div className="log-meta">System prompt</div>
                <pre>{requestLog.system_prompt}</pre>
                <div className="log-meta">User message (post-obfuscation, as sent)</div>
                <pre>{requestLog.user_message}</pre>
              </details>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2>Settings</h2>
        <div className="setting-row">
          <div className="setting-text">
            <strong>Telemetry</strong>
            <p className="muted small">
              Off by default. If enabled, future versions of the app may
              send anonymous usage counts (e.g. number of queries
              generated, error categories). Telemetry never includes
              schema names, query text, or any database content. As of
              this build no telemetry is sent regardless of this toggle —
              the toggle is a placeholder for the future telemetry
              pipeline so you can opt in early.
            </p>
          </div>
          <button
            className={`toggle-chip${telemetryEnabled ? " on" : ""}`}
            onClick={() => void toggleTelemetry()}
          >
            {telemetryEnabled ? "ON" : "OFF"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Security review pack</h2>
        <p className="muted small">
          Generates a PDF you can hand to a security or compliance
          reviewer. The PDF contains the security model, your current
          configuration (database, provider, redaction state), every
          network endpoint the app contacts, and the verbatim SQL used
          for schema extraction. Built locally; nothing is fetched.
        </p>
        <div className="row">
          <button onClick={() => void exportSecurityPdf()} disabled={pdfBusy}>
            {pdfBusy ? "Building PDF…" : "Export security review PDF"}
          </button>
        </div>
        {pdfStatus && (
          <div className="status status-ok">
            Saved {(pdfStatus.bytes / 1024).toFixed(1)} KB to:{" "}
            <code>{pdfStatus.path}</code>
          </div>
        )}
        {pdfError && <div className="status status-error">{pdfError}</div>}
      </section>
    </main>
  );
}

function cellRender(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export default App;
