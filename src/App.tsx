import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import type {
  ConnectionProfile,
  EmbeddingStats,
  ExecutionResult,
  ModelRegistry,
  ProviderConfig,
  ProviderKind,
  SchemaModel,
  ValidatedSql,
} from "./types";

type Validation =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; referenced: string[] }
  | { state: "error"; message: string };

type NewProfileForm = {
  name: string;
  host: string;
  port: string; // string in form, parsed to u16 on submit
  database: string;
  username: string;
  password: string;
};

const EMPTY_FORM: NewProfileForm = {
  name: "",
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

  useEffect(() => {
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

  async function testConnection() {
    setFormBusy(true);
    setTestStatus(null);
    try {
      const port = parseInt(form.port, 10);
      if (Number.isNaN(port)) throw new Error("port must be a number");
      await invoke("test_connection", {
        req: {
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
          dialect: "postgres",
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
    setValidation({ state: "idle" });
    setResults(null);
    setExecuteError(null);
    try {
      const sql = await invoke<string>("generate_sql", {
        connectionId: selectedId,
        question,
      });
      setGeneratedSql(sql);
      void validate(sql);
    } catch (e) {
      setGenerateError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function validate(sql: string) {
    if (!selectedId) return;
    setValidation({ state: "running" });
    try {
      const v = await invoke<ValidatedSql>("validate_sql", {
        connectionId: selectedId,
        sql,
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

  return (
    <main className="container">
      <h1>SQL Mate</h1>
      <p className="subtitle">
        Phase 2 — live Postgres extraction, SQLCipher-encrypted local store. OS
        keychain integration deferred to Phase 7 (see PHASE_2_LOG.md).
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
              Use a read-only Postgres role per <code>SECURITY_MODEL.md</code>. The password
              is stored inside the SQLCipher-encrypted local store (Phase 7 will revisit OS
              keychain integration).
            </p>
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
              <div className="schema-tree">
                {schema.schemas.map((s) => (
                  <div key={s.name} className="schema-block">
                    <div className="schema-name">{s.name}</div>
                    {s.tables.map((t) => (
                      <details key={t.name} className="table-block">
                        <summary>
                          <span className="table-name">{t.name}</span>
                          <span className="muted small">
                            {" "}
                            ({t.columns.length} col{t.columns.length === 1 ? "" : "s"})
                          </span>
                        </summary>
                        <ul className="column-list">
                          {t.columns.map((c) => (
                            <li key={c.name}>
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
                            </li>
                          ))}
                        </ul>
                      </details>
                    ))}
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
        </section>
      )}
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
