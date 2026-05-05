import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import type { ConnectionProfile, SchemaModel } from "./types";

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

function App() {
  // API key
  const [apiKeySaved, setApiKeySaved] = useState<boolean | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyBusy, setApiKeyBusy] = useState(false);

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

  useEffect(() => {
    void invoke<boolean>("has_api_key").then(setApiKeySaved).catch(() => setApiKeySaved(false));
    void refreshProfiles();
  }, []);

  useEffect(() => {
    setSchema(null);
    setExtractError(null);
    setGeneratedSql(null);
    setGenerateError(null);
    if (!selectedId) return;
    void invoke<SchemaModel | null>("get_persisted_schema", { connectionId: selectedId })
      .then(setSchema)
      .catch((e) => setExtractError(String(e)));
  }, [selectedId]);

  async function refreshProfiles() {
    const list = await invoke<ConnectionProfile[]>("list_connection_profiles");
    setProfiles(list);
  }

  async function saveApiKey() {
    if (!apiKeyDraft.trim()) return;
    setApiKeyBusy(true);
    try {
      await invoke("save_api_key", { apiKey: apiKeyDraft });
      setApiKeyDraft("");
      setApiKeySaved(true);
    } catch (e) {
      alert(`Could not save API key: ${e}`);
    } finally {
      setApiKeyBusy(false);
    }
  }

  async function clearApiKey() {
    setApiKeyBusy(true);
    try {
      await invoke("delete_api_key");
      setApiKeySaved(false);
    } finally {
      setApiKeyBusy(false);
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
    try {
      const sql = await invoke<string>("generate_sql", {
        connectionId: selectedId,
        question,
      });
      setGeneratedSql(sql);
    } catch (e) {
      setGenerateError(String(e));
    } finally {
      setGenerating(false);
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
        <h2>Anthropic API key</h2>
        {apiKeySaved === null ? (
          <p className="muted">Loading…</p>
        ) : apiKeySaved ? (
          <div className="row">
            <span className="status status-ok">Saved in encrypted local store</span>
            <button onClick={clearApiKey} disabled={apiKeyBusy} className="secondary">
              Clear
            </button>
          </div>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void saveApiKey();
            }}
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.currentTarget.value)}
            />
            <button type="submit" disabled={apiKeyBusy || !apiKeyDraft.trim()}>
              Save
            </button>
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
                disabled={generating || !question.trim() || !apiKeySaved}
              >
                {generating ? "Generating…" : "Generate SQL"}
              </button>
              {!apiKeySaved && (
                <span className="muted small">Save an API key above first.</span>
              )}
            </div>
          </form>
          {generateError && <div className="status status-error">{generateError}</div>}
          {generatedSql && (
            <div className="output">
              <div className="output-label">Generated SQL</div>
              <pre>{generatedSql}</pre>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

export default App;
