// Phase 9 UX overhaul: clean three-section home (schema, ask, generated SQL),
// nav bar with modal dialogs for providers/connections/settings/security,
// session-scoped query history, syntax-highlighted SQL block, click-to-copy.
// Run-query button removed entirely — see SECURITY_MODEL.md T2.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { Onboarding } from "./Onboarding";
import { SqlBlock } from "./SqlBlock";
import type {
  ConnectionProfile,
  EmbeddingStats,
  GenerationResult,
  HistoryEntry,
  ModelRegistry,
  ProviderConfig,
  ProviderKind,
  RequestLogEntry,
  SchemaModel,
  SessionTurn,
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

type DialogId = "providers" | "connections" | "settings" | "security" | "history" | null;

type SessionHistoryItem = {
  question: string;
  sql: string;
  model: string;
  validationStatus: "pending" | "ok" | "error";
  validationMessage?: string;
  timestamp: number;
};

function App() {
  // LLM provider configuration
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [registry, setRegistry] = useState<ModelRegistry | null>(null);
  const [providerForm, setProviderForm] = useState<NewProviderForm>(defaultProviderForm(null));
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [showAddProvider, setShowAddProvider] = useState(false);

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

  // Model picker
  const [pickerOpen, setPickerOpen] = useState(false);

  // Validation
  const [validation, setValidation] = useState<Validation>({ state: "idle" });

  // Embeddings (kept; surface lives inside the schema panel)
  const [embeddingStats, setEmbeddingStats] = useState<EmbeddingStats | null>(null);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);

  // Annotations + redactions
  type EditingTarget = { schemaName: string; tableName: string; columnName: string | null };
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [requestLog, setRequestLog] = useState<RequestLogEntry | null>(null);

  // Phase 9 settings + onboarding
  const [onboardingActive, setOnboardingActive] = useState<boolean | null>(null);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<{ path: string; bytes: number } | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // Phase 11 widget polish
  const [widgetHotkey, setWidgetHotkey] = useState<string>("CommandOrControl+Shift+Space");
  const [widgetHotkeyError, setWidgetHotkeyError] = useState<string | null>(null);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [hotkeySaveError, setHotkeySaveError] = useState<string | null>(null);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);

  // ADR 0017: opt-in session context + follow-up suggestions
  const [sessionContextEnabled, setSessionContextEnabled] = useState(false);
  const [followupSuggestionsEnabled, setFollowupSuggestionsEnabled] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  // Persisted query history (loaded when the History dialog opens)
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Phase 9 UX overhaul state
  const [openDialog, setOpenDialog] = useState<DialogId>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryItem[]>([]);
  const dialogRefs = {
    providers: useRef<HTMLDialogElement>(null),
    connections: useRef<HTMLDialogElement>(null),
    settings: useRef<HTMLDialogElement>(null),
    security: useRef<HTMLDialogElement>(null),
    history: useRef<HTMLDialogElement>(null),
  };

  useEffect(() => {
    void invoke<boolean>("get_onboarding_completed").then((done) => {
      setOnboardingActive(!done);
    });
    void invoke<boolean>("get_telemetry_enabled").then(setTelemetryEnabled);
    void invoke<string>("get_widget_hotkey").then(setWidgetHotkey);
    void invoke<string | null>("get_widget_hotkey_error").then(setWidgetHotkeyError);
    void invoke<boolean>("get_autostart_enabled")
      .then(setAutostartEnabled)
      .catch((e) => setAutostartError(String(e)));
    void invoke<boolean>("get_session_context_enabled").then(setSessionContextEnabled);
    void invoke<boolean>("get_followup_suggestions_enabled").then(setFollowupSuggestionsEnabled);
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

  // Imperatively open / close native <dialog> elements when openDialog changes.
  useEffect(() => {
    (Object.keys(dialogRefs) as Array<keyof typeof dialogRefs>).forEach((id) => {
      const dlg = dialogRefs[id].current;
      if (!dlg) return;
      if (openDialog === id && !dlg.open) dlg.showModal();
      if (openDialog !== id && dlg.open) dlg.close();
    });
  }, [openDialog]);

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
      await invoke<ProviderConfig>("create_provider_config", {
        req: {
          name: providerForm.name || providerForm.kind,
          kind: providerForm.kind,
          base_url: providerForm.base_url,
          model: providerForm.model,
          api_key: providerForm.api_key,
        },
      });
      await refreshProviders();
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
      const s = await invoke<EmbeddingStats>("get_embedding_stats", { connectionId });
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
      const s = await invoke<EmbeddingStats>("embed_schema", { connectionId: selectedId });
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
      const entry = await invoke<RequestLogEntry | null>("get_last_request_log", { connectionId });
      setRequestLog(entry);
    } catch {
      setRequestLog(null);
    }
  }

  async function toggleTelemetry() {
    const next = !telemetryEnabled;
    await invoke("set_telemetry_enabled", { enabled: next });
    setTelemetryEnabled(next);
  }

  // Phase 11: hotkey recording. Listens for the next keydown that includes
  // at least one modifier and a non-modifier key, formats it as a Tauri
  // shortcut string, and submits.
  function startRecordingHotkey() {
    setRecordingHotkey(true);
    setHotkeySaveError(null);
  }

  function cancelRecordingHotkey() {
    setRecordingHotkey(false);
  }

  useEffect(() => {
    if (!recordingHotkey) return;
    const handler = async (e: KeyboardEvent) => {
      // Esc cancels.
      if (e.key === "Escape") {
        e.preventDefault();
        setRecordingHotkey(false);
        return;
      }
      // Ignore lone modifier presses — wait for the actual key.
      if (["Shift", "Control", "Alt", "Meta", "OS", "AltGraph"].includes(e.key)) {
        return;
      }
      e.preventDefault();
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Control");
      if (e.shiftKey) mods.push("Shift");
      if (e.altKey) mods.push("Alt");
      if (e.metaKey) mods.push("Meta");
      if (mods.length === 0) {
        setHotkeySaveError(
          "Hotkey must include at least one modifier (Ctrl, Shift, Alt, or Meta).",
        );
        return;
      }
      const main = formatKeyForTauri(e.code, e.key);
      if (!main) {
        setHotkeySaveError(`Unsupported key: ${e.key}`);
        return;
      }
      const combo = [...mods, main].join("+");
      try {
        await invoke("set_widget_hotkey", { hotkey: combo });
        setWidgetHotkey(combo);
        setWidgetHotkeyError(null);
        setRecordingHotkey(false);
        setHotkeySaveError(null);
      } catch (err) {
        setHotkeySaveError(String(err));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingHotkey]);

  async function toggleAutostart() {
    const next = !autostartEnabled;
    setAutostartError(null);
    try {
      await invoke("set_autostart_enabled", { enabled: next });
      setAutostartEnabled(next);
    } catch (e) {
      setAutostartError(String(e));
    }
  }

  async function exportSecurityPdf() {
    setPdfBusy(true);
    setPdfError(null);
    setPdfStatus(null);
    try {
      const result = await invoke<{ path: string; byte_count: number }>("export_security_pdf", {
        connectionId: selectedId,
      });
      setPdfStatus({ path: result.path, bytes: result.byte_count });
    } catch (e) {
      setPdfError(String(e));
    } finally {
      setPdfBusy(false);
    }
  }

  async function createProfile() {
    setFormBusy(true);
    setTestStatus(null);
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
    } catch (e) {
      setTestStatus({ ok: false, msg: String(e) });
    } finally {
      setFormBusy(false);
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

  async function deleteProfile(id: string) {
    if (!confirm("Delete this connection profile?")) return;
    await invoke("delete_connection_profile", { id });
    if (selectedId === id) setSelectedId(null);
    await refreshProfiles();
  }

  async function extractSchema() {
    if (!selectedId) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const model = await invoke<SchemaModel>("extract_schema", { connectionId: selectedId });
      setSchema(model);
      await refreshEmbeddingStats(selectedId);
    } catch (e) {
      setExtractError(String(e));
    } finally {
      setExtracting(false);
    }
  }

  // Accepts an optional override question so suggestion chips can fire
  // generation immediately without waiting for setQuestion to flush (ADR 0017).
  async function generate(overrideQuestion?: string) {
    const q = overrideQuestion ?? question;
    if (!selectedId || !q.trim()) return;
    if (overrideQuestion) setQuestion(overrideQuestion);
    setGenerating(true);
    setGeneratedSql(null);
    setGenerateError(null);
    setHistoryId(null);
    setGeneratedByModel(null);
    setValidation({ state: "idle" });
    setSuggestions([]);
    setSuggestionsLoading(false);

    // Build session history to pass when context is enabled (ADR 0017).
    // sessionHistory is newest-first; reverse to chronological for the backend.
    const historyForBackend: SessionTurn[] = sessionContextEnabled
      ? sessionHistory
          .slice()
          .reverse()
          .map((h) => ({ question: h.question, sql: h.sql }))
      : [];

    try {
      const result = await invoke<GenerationResult>("generate_sql", {
        connectionId: selectedId,
        question: q,
        sessionHistory: historyForBackend.length > 0 ? historyForBackend : null,
      });
      setGeneratedSql(result.sql);
      setHistoryId(result.history_id);
      setGeneratedByModel(result.model);
      setSessionHistory((prev) => [
        {
          question: q,
          sql: result.sql,
          model: result.model,
          validationStatus: "pending",
          timestamp: Date.now(),
        },
        ...prev,
      ]);
      void refreshRequestLog(selectedId);
      void validate(result.sql, result.history_id);

      // Fetch follow-up suggestions in the background (ADR 0017).
      // Best-effort: never blocks the SQL result.
      if (followupSuggestionsEnabled) {
        setSuggestionsLoading(true);
        void invoke<string[]>("get_followup_suggestions", {
          connectionId: selectedId,
          question: q,
          sql: result.sql,
        })
          .then((s) => setSuggestions(s))
          .catch(() => setSuggestions([]))
          .finally(() => setSuggestionsLoading(false));
      }
    } catch (e) {
      setGenerateError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function openHistory() {
    if (!selectedProfile) return;
    setOpenDialog("history");
    setHistoryLoading(true);
    try {
      const entries = await invoke<HistoryEntry[]>("list_history", {
        connectionId: selectedProfile.id,
        limit: 100,
      });
      setHistoryEntries(entries);
    } catch {
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function toggleSessionContext() {
    const next = !sessionContextEnabled;
    await invoke("set_session_context_enabled", { enabled: next });
    setSessionContextEnabled(next);
  }

  async function toggleFollowupSuggestions() {
    const next = !followupSuggestionsEnabled;
    await invoke("set_followup_suggestions_enabled", { enabled: next });
    setFollowupSuggestionsEnabled(next);
    if (!next) setSuggestions([]);
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
      setSessionHistory((prev) =>
        prev.map((h, i) => (i === 0 ? { ...h, validationStatus: "ok" } : h)),
      );
    } catch (e) {
      const msg = String(e);
      setValidation({ state: "error", message: msg });
      setSessionHistory((prev) =>
        prev.map((h, i) =>
          i === 0 ? { ...h, validationStatus: "error", validationMessage: msg } : h,
        ),
      );
    }
  }

  if (onboardingActive === null) return null;
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

  const selectedProfile = profiles.find((p) => p.id === selectedId) ?? null;
  const activeProvider = providers.find((p) => p.id === activeProviderId) ?? null;
  const activeRegProvider = activeProvider && registry
    ? registry.providers.find((rp) => rp.kind === activeProvider.kind) ?? null
    : null;
  const activeModel = activeRegProvider?.models.find((m) => m.id === activeProvider?.model) ?? null;

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">SQL Mate</div>
        <nav className="topbar-nav">
          <button className={`topbar-link${openDialog === "providers" ? " active" : ""}`} onClick={() => setOpenDialog("providers")}>
            Providers
          </button>
          <button className={`topbar-link${openDialog === "connections" ? " active" : ""}`} onClick={() => setOpenDialog("connections")}>
            Connections
          </button>
          {selectedProfile && (
            <button className={`topbar-link${openDialog === "history" ? " active" : ""}`} onClick={() => void openHistory()}>
              History
            </button>
          )}
          <button className={`topbar-link${openDialog === "settings" ? " active" : ""}`} onClick={() => setOpenDialog("settings")}>
            Settings
          </button>
          <button className={`topbar-link${openDialog === "security" ? " active" : ""}`} onClick={() => setOpenDialog("security")}>
            Security review
          </button>
        </nav>
      </header>

      <main className="container">
        {!selectedProfile && (
          <section className="card empty-state">
            <h2>Pick a connection to get started</h2>
            <p className="muted">
              Use the <strong>Connections</strong> link in the top right to add or
              choose a database.
            </p>
            <button onClick={() => setOpenDialog("connections")}>Open Connections</button>
          </section>
        )}

        {selectedProfile && (
          <>
            <section className="card">
              <div className="card-header">
                <div>
                  <h2>Schema</h2>
                  <p className="muted small connection-summary">
                    {selectedProfile.name} · {selectedProfile.dialect} ·{" "}
                    <code>
                      {selectedProfile.host}:{selectedProfile.port}/
                      {selectedProfile.database_name}
                    </code>
                  </p>
                </div>
                <button onClick={extractSchema} disabled={extracting} className="secondary">
                  {extracting ? "Extracting…" : schema ? "Re-extract" : "Extract schema"}
                </button>
              </div>
              {extractError && <div className="status status-error">{extractError}</div>}
              {!schema && !extractError && (
                <p className="muted">No schema extracted yet for this connection.</p>
              )}
              {schema && (
                <>
                  <p className="muted small">
                    Extracted {new Date(schema.extracted_at * 1000).toLocaleString()}.
                  </p>
                  {embeddingStats && (
                    <div className="row" style={{ margin: "0.5rem 0", flexWrap: "wrap" }}>
                      <span className="muted small">
                        {embeddingStats.total_tables} tables,{" "}
                        {embeddingStats.embedded_count} embeddings
                        {embeddingStats.total_tables >= embeddingStats.retrieval_threshold
                          ? ` (above retrieval threshold ${embeddingStats.retrieval_threshold})`
                          : " (below retrieval threshold; embeddings unused)"}
                        {embeddingStats.embedded_at && (
                          <>
                            {" — "}
                            {new Date(embeddingStats.embedded_at * 1000).toLocaleString()}
                            {embeddingStats.model && ` · ${embeddingStats.model}`}
                          </>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={generateEmbeddings}
                        disabled={embeddingBusy}
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
                  {embeddingError && <div className="status status-error">{embeddingError}</div>}

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
                          const editingTable =
                            editing?.schemaName === s.name &&
                            editing.tableName === t.name &&
                            editing.columnName === null;
                          return (
                            <details
                              key={t.name}
                              className={`table-block${t.excluded ? " excluded" : ""}`}
                            >
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
                                      startAnnotating(
                                        { schemaName: s.name, tableName: t.name, columnName: null },
                                        t.user_annotation ?? null,
                                      );
                                    }}
                                  >
                                    {t.user_annotation ? "edit note" : "add note"}
                                  </button>
                                </span>
                              </summary>
                              {t.user_annotation && !editingTable && (
                                <span className="annotation-text">— {t.user_annotation}</span>
                              )}
                              {editingTable && (
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
                                  const editingCol =
                                    editing?.schemaName === s.name &&
                                    editing.tableName === t.name &&
                                    editing.columnName === c.name;
                                  return (
                                    <li
                                      key={c.name}
                                      className={c.sensitive ? "sensitive" : ""}
                                    >
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
                                          onClick={() =>
                                            void toggleSensitive(s.name, t.name, c.name, c.sensitive)
                                          }
                                        >
                                          {c.sensitive ? "sensitive" : "mark sensitive"}
                                        </button>
                                        <button
                                          type="button"
                                          className="toggle-chip"
                                          onClick={() =>
                                            startAnnotating(
                                              {
                                                schemaName: s.name,
                                                tableName: t.name,
                                                columnName: c.name,
                                              },
                                              c.user_annotation ?? null,
                                            )
                                          }
                                        >
                                          {c.user_annotation ? "edit note" : "add note"}
                                        </button>
                                      </span>
                                      {c.user_annotation && !editingCol && (
                                        <span className="annotation-text">
                                          — {c.user_annotation}
                                        </span>
                                      )}
                                      {editingCol && (
                                        <div className="annotation-editor">
                                          <textarea
                                            rows={2}
                                            value={annotationDraft}
                                            onChange={(e) =>
                                              setAnnotationDraft(e.currentTarget.value)
                                            }
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

            {schema && (
              <section className="card card-focal">
                <div className="ask-header">
                  <h2>Ask a question</h2>
                  <div className="feature-toggles">
                    <button
                      className={`feature-toggle${sessionContextEnabled ? " on" : ""}`}
                      onClick={() => void toggleSessionContext()}
                      title="When on, the last 5 Q+SQL pairs from this session are sent to the LLM so you can ask follow-ups like 'now filter that by region'."
                    >
                      Session context {sessionContextEnabled ? "ON" : "OFF"}
                    </button>
                    <button
                      className={`feature-toggle${followupSuggestionsEnabled ? " on" : ""}`}
                      onClick={() => void toggleFollowupSuggestions()}
                      title="When on, generates 3 suggested follow-up questions after each query."
                    >
                      Suggestions {followupSuggestionsEnabled ? "ON" : "OFF"}
                    </button>
                  </div>
                </div>
                <ModelPicker
                  active={activeProvider}
                  registry={registry}
                  providers={providers}
                  activeProviderId={activeProviderId}
                  open={pickerOpen}
                  onToggle={() => setPickerOpen((v) => !v)}
                  onPick={(pid, mid) => void switchToModel(pid, mid)}
                  triggerLabel={
                    activeProvider
                      ? activeModel
                        ? `${activeModel.name} · ${activeModel.cost_tier} cost`
                        : `${activeProvider.name} · ${activeProvider.model}`
                      : "No provider configured"
                  }
                />
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
                      <span className="muted small">
                        Configure a provider first (top right →{" "}
                        <button className="link" onClick={() => setOpenDialog("providers")}>
                          Providers
                        </button>
                        ).
                      </span>
                    )}
                  </div>
                </form>
                {generateError && <div className="status status-error">{generateError}</div>}
              </section>
            )}

            {generatedSql && (
              <section className="card card-focal">
                <div className="card-header">
                  <h2>Generated SQL</h2>
                  {generatedByModel && (
                    <span className="muted small">
                      Generated by <code>{generatedByModel}</code>
                    </span>
                  )}
                </div>
                <SqlBlock sql={generatedSql} />
                <ValidationStatus validation={validation} />

                {/* ADR 0017: follow-up suggestion chips */}
                {followupSuggestionsEnabled && (suggestionsLoading || suggestions.length > 0) && (
                  <div className="suggestion-chips">
                    {suggestionsLoading && suggestions.length === 0 && (
                      <span className="suggestions-loading">fetching suggestions…</span>
                    )}
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        className="suggestion-chip"
                        onClick={() => void generate(s)}
                        disabled={generating}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
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

                {sessionHistory.length > 1 && (
                  <div className="session-history">
                    <h3>Session history</h3>
                    <p className="muted small">
                      {sessionHistory.length} quer{sessionHistory.length === 1 ? "y" : "ies"} this
                      session. In-memory only — clears on app restart.
                    </p>
                    <ul>
                      {sessionHistory.slice(1).map((h, i) => (
                        <li key={i} className="history-item">
                          <div className="history-meta">
                            <span className="muted small">
                              {new Date(h.timestamp).toLocaleTimeString()} ·{" "}
                              <code>{h.model}</code>
                            </span>
                            {h.validationStatus === "ok" && (
                              <span className="badge badge-ok">valid</span>
                            )}
                            {h.validationStatus === "error" && (
                              <span className="badge badge-error">invalid</span>
                            )}
                          </div>
                          <div className="history-question">{h.question}</div>
                          <SqlBlock sql={h.sql} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>

      {/* ----------------- Modal dialogs ----------------- */}

      <dialog
        ref={dialogRefs.providers}
        className="app-dialog"
        onClose={() => setOpenDialog(null)}
      >
        <div className="dialog-header">
          <h2>LLM providers</h2>
          <button
            className="dialog-close"
            onClick={() => setOpenDialog(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          {providers.length === 0 && !showAddProvider && (
            <p className="muted">No provider configured. Click "Add provider" to set one up.</p>
          )}
          {providers.length > 0 && (
            <ul className="profile-list">
              {providers.map((p) => (
                <li key={p.id} className={p.id === activeProviderId ? "selected" : ""}>
                  <button className="profile-row" onClick={() => void setActive(p.id)}>
                    <span className="profile-name">{p.name}</span>
                    <span className="profile-detail">
                      {p.kind} · {p.model}
                    </span>
                  </button>
                  <button onClick={() => void deleteProvider(p.id)} className="link-danger">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!showAddProvider && (
            <div className="row" style={{ marginTop: "0.6rem" }}>
              <button onClick={() => setShowAddProvider(true)} className="secondary">
                Add provider
              </button>
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
                API key is stored in the SQLCipher-encrypted local store on this machine.
              </p>
              <div className="row">
                <label className="grow">
                  Provider
                  <select
                    value={providerForm.kind}
                    onChange={(e) =>
                      setProviderForm(setRegistryDefaultsForKind(
                        e.currentTarget.value as ProviderKind,
                        providerForm,
                      ))
                    }
                  >
                    {registry.providers.map((p) => (
                      <option key={p.id} value={p.kind}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grow">
                  Model
                  <select
                    value={providerForm.model}
                    onChange={(e) =>
                      setProviderForm({ ...providerForm, model: e.currentTarget.value })
                    }
                  >
                    {registry.providers
                      .find((p) => p.kind === providerForm.kind)
                      ?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} · {m.cost_tier} cost
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label>
                Friendly name
                <input
                  value={providerForm.name}
                  onChange={(e) =>
                    setProviderForm({ ...providerForm, name: e.currentTarget.value })
                  }
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
                API key
                <input
                  type="password"
                  value={providerForm.api_key}
                  onChange={(e) =>
                    setProviderForm({ ...providerForm, api_key: e.currentTarget.value })
                  }
                />
              </label>
              {providerError && <div className="status status-error">{providerError}</div>}
              <div className="row">
                <button type="submit" disabled={providerBusy || !providerForm.api_key.trim()}>
                  {providerBusy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setShowAddProvider(false);
                    setProviderError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>

      <dialog
        ref={dialogRefs.connections}
        className="app-dialog"
        onClose={() => setOpenDialog(null)}
      >
        <div className="dialog-header">
          <h2>Connections</h2>
          <button
            className="dialog-close"
            onClick={() => setOpenDialog(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          {profiles.length === 0 && !showAddForm && (
            <p className="muted">
              No connections yet. Click "Add connection" to set one up.
            </p>
          )}
          {profiles.length > 0 && (
            <ul className="profile-list">
              {profiles.map((p) => (
                <li key={p.id} className={p.id === selectedId ? "selected" : ""}>
                  <button
                    className="profile-row"
                    onClick={() => {
                      setSelectedId(p.id);
                      setOpenDialog(null);
                    }}
                  >
                    <span className="profile-name">{p.name}</span>
                    <span className="profile-detail">
                      {p.dialect} · {p.host}:{p.port}/{p.database_name}
                    </span>
                  </button>
                  <button onClick={() => void deleteProfile(p.id)} className="link-danger">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!showAddForm && (
            <div className="row" style={{ marginTop: "0.6rem" }}>
              <button onClick={() => setShowAddForm(true)} className="secondary">
                Add connection
              </button>
            </div>
          )}

          {showAddForm && (
            <form
              className="profile-form"
              onSubmit={(e) => {
                e.preventDefault();
                void createProfile();
              }}
            >
              <p className="muted small">
                Use database credentials that are read-only at the database
                layer. The app does not execute generated SQL — you copy and run
                it elsewhere — but read-only roles are good hygiene anyway.
              </p>
              <div className="row">
                <label className="grow">
                  Dialect
                  <select
                    value={form.dialect}
                    onChange={(e) => {
                      const dialect = e.currentTarget.value as DbDialect;
                      const opt = DIALECT_OPTIONS.find((d) => d.value === dialect);
                      setForm({
                        ...form,
                        dialect,
                        port: opt?.default_port || form.port,
                      });
                    }}
                  >
                    {DIALECT_OPTIONS.map((d) => (
                      <option key={d.value} value={d.value} disabled={!d.enabled}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="port">
                  Port
                  <input
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.currentTarget.value })}
                  />
                </label>
              </div>
              <label>
                Host
                <input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.currentTarget.value })}
                />
              </label>
              <label>
                Database
                <input
                  value={form.database}
                  onChange={(e) => setForm({ ...form, database: e.currentTarget.value })}
                />
              </label>
              <div className="row">
                <label className="grow">
                  Username
                  <input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.currentTarget.value })}
                  />
                </label>
                <label className="grow">
                  Password
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
                  />
                </label>
              </div>
              <label>
                Friendly name
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
                />
              </label>
              {testStatus && (
                <div className={testStatus.ok ? "status status-ok" : "status status-error"}>
                  {testStatus.msg}
                </div>
              )}
              <div className="row">
                <button
                  type="button"
                  onClick={() => void testConnection()}
                  disabled={formBusy}
                  className="secondary"
                >
                  {formBusy ? "Testing…" : "Test connection"}
                </button>
                <button type="submit" disabled={formBusy}>
                  Save
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setShowAddForm(false);
                    setTestStatus(null);
                    setForm(EMPTY_FORM);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>

      <dialog
        ref={dialogRefs.settings}
        className="app-dialog"
        onClose={() => setOpenDialog(null)}
      >
        <div className="dialog-header">
          <h2>Settings</h2>
          <button
            className="dialog-close"
            onClick={() => setOpenDialog(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          <div className="setting-row">
            <div className="setting-text">
              <strong>Widget hotkey</strong>
              <p className="muted small">
                The keyboard shortcut that summons the floating widget from
                anywhere. Click "Change" and press the combo you want.
                Requires at least one modifier (Ctrl, Shift, Alt, Meta).
              </p>
              {widgetHotkeyError && (
                <div className="status status-error" style={{ marginTop: "0.4rem" }}>
                  Hotkey unavailable on this machine: {widgetHotkeyError}. Use
                  the tray icon to summon the widget, or rebind below.
                </div>
              )}
              {hotkeySaveError && (
                <div className="status status-error" style={{ marginTop: "0.4rem" }}>
                  {hotkeySaveError}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem" }}>
              <code className="kbd-chip">
                {recordingHotkey ? "Press combo…" : prettyHotkey(widgetHotkey)}
              </code>
              {recordingHotkey ? (
                <button className="link" onClick={cancelRecordingHotkey}>
                  Cancel (Esc)
                </button>
              ) : (
                <button className="secondary" onClick={startRecordingHotkey}>
                  Change
                </button>
              )}
            </div>
          </div>

          <div className="setting-row" style={{ marginTop: "1rem" }}>
            <div className="setting-text">
              <strong>Start with Windows</strong>
              <p className="muted small">
                Launch SQL Mate automatically when you sign in to Windows.
                The widget stays hidden in the tray until you press the
                hotkey, so this does not slow down login. Off by default.
              </p>
              {autostartError && (
                <div className="status status-error" style={{ marginTop: "0.4rem" }}>
                  {autostartError}
                </div>
              )}
            </div>
            <button
              className={`toggle-chip${autostartEnabled ? " on" : ""}`}
              onClick={() => void toggleAutostart()}
            >
              {autostartEnabled ? "ON" : "OFF"}
            </button>
          </div>

          <div className="setting-row" style={{ marginTop: "1rem" }}>
            <div className="setting-text">
              <strong>Session context</strong>
              <p className="muted small">
                When on, the last 5 Q+SQL pairs from this session are sent to
                the LLM alongside your next question, so you can ask follow-ups
                like "now filter that by region" without restating context.
                Off by default. When enabled, previous queries in this session
                are included in every LLM request — see the security model
                for what that means.
              </p>
            </div>
            <button
              className={`toggle-chip${sessionContextEnabled ? " on" : ""}`}
              onClick={() => void toggleSessionContext()}
            >
              {sessionContextEnabled ? "ON" : "OFF"}
            </button>
          </div>

          <div className="setting-row" style={{ marginTop: "1rem" }}>
            <div className="setting-text">
              <strong>Follow-up suggestions</strong>
              <p className="muted small">
                When on, after each SQL generation the app makes a second
                lightweight LLM call and shows up to 3 suggested follow-up
                questions as clickable chips. Clicking a chip pre-fills the
                question and generates immediately. Off by default. Each
                generation fires one extra LLM request when this is enabled.
              </p>
            </div>
            <button
              className={`toggle-chip${followupSuggestionsEnabled ? " on" : ""}`}
              onClick={() => void toggleFollowupSuggestions()}
            >
              {followupSuggestionsEnabled ? "ON" : "OFF"}
            </button>
          </div>

          <div className="setting-row" style={{ marginTop: "1rem" }}>
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
        </div>
      </dialog>

      {/* ── History dialog ──────────────────────────────────── */}
      <dialog
        ref={dialogRefs.history}
        className="app-dialog app-dialog--wide"
        onClose={() => setOpenDialog(null)}
      >
        <div className="dialog-header">
          <h2>Query history</h2>
          <button
            className="dialog-close"
            onClick={() => setOpenDialog(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          {historyLoading && <p className="muted small">Loading…</p>}
          {!historyLoading && historyEntries.length === 0 && (
            <p className="muted small">No queries recorded for this connection yet.</p>
          )}
          {!historyLoading && historyEntries.length > 0 && (
            <ul className="history-list">
              {historyEntries.map((entry) => (
                <li key={entry.id} className="history-list-item">
                  <div className="history-list-meta">
                    <span className="muted small">
                      {new Date(entry.asked_at * 1000).toLocaleString()}
                    </span>
                    {entry.validation_status === "ok" && (
                      <span className="badge badge-ok">valid</span>
                    )}
                    {entry.validation_status === "error" && (
                      <span className="badge badge-error">invalid</span>
                    )}
                    {entry.validation_status === "pending" && (
                      <span className="badge">pending</span>
                    )}
                  </div>
                  <div className="history-list-question">{entry.question}</div>
                  {entry.generated_sql && <SqlBlock sql={entry.generated_sql} />}
                  {entry.validation_error && (
                    <div className="status status-error" style={{ marginTop: "0.4rem" }}>
                      {entry.validation_error}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </dialog>

      <dialog
        ref={dialogRefs.security}
        className="app-dialog"
        onClose={() => setOpenDialog(null)}
      >
        <div className="dialog-header">
          <h2>Security review pack</h2>
          <button
            className="dialog-close"
            onClick={() => setOpenDialog(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          <p className="muted small">
            Generates a PDF you can hand to a security or compliance reviewer.
            Contains the security model, your current configuration (database,
            provider, redaction state), every network endpoint the app
            contacts, and the verbatim SQL used for schema extraction. Built
            locally; nothing is fetched.
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
        </div>
      </dialog>
    </>
  );
}

function ValidationStatus({ validation }: { validation: Validation }) {
  if (validation.state === "running") {
    return <div className="status">Validating with sqlglot…</div>;
  }
  if (validation.state === "error") {
    return <div className="status status-error">Validation failed: {validation.message}</div>;
  }
  if (validation.state === "ok") {
    return (
      <div className="status status-ok">
        Validation passed. References:{" "}
        {validation.referenced.length === 0 ? "(none)" : validation.referenced.join(", ")}
      </div>
    );
  }
  return null;
}

type ModelPickerProps = {
  active: ProviderConfig | null;
  registry: ModelRegistry | null;
  providers: ProviderConfig[];
  activeProviderId: string | null;
  open: boolean;
  onToggle: () => void;
  onPick: (providerId: string, modelId: string) => void;
  triggerLabel: string;
};

function ModelPicker({
  active,
  registry,
  providers,
  activeProviderId,
  open,
  onToggle,
  onPick,
  triggerLabel,
}: ModelPickerProps) {
  return (
    <div className="model-picker">
      <button
        type="button"
        className="picker-trigger"
        onClick={onToggle}
        disabled={!active || providers.length === 0}
      >
        <span>{triggerLabel}</span>
        <span className="chevron">{open ? "▴" : "▾"}</span>
      </button>
      {open && registry && (
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
                      onClick={() => onPick(p.id, m.id)}
                    >
                      <span>{m.name}</span>
                      <span className={`cost-tier cost-${m.cost_tier}`}>{m.cost_tier}</span>
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
}

/**
 * Format a KeyboardEvent's key for Tauri's global-shortcut Shortcut::from_str
 * parser. Tauri uses keyboard-code style ("KeyA", "Digit1", "F1", "Space",
 * etc.) — we map e.code directly when possible.
 */
function formatKeyForTauri(code: string, key: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code; // e.g. "KeyA"
  if (/^Digit\d$/.test(code)) return code; // e.g. "Digit1"
  if (/^Numpad\d$/.test(code)) return code;
  if (/^F\d{1,2}$/.test(code)) return code; // F1..F24
  switch (code) {
    case "Space":
    case "Enter":
    case "Tab":
    case "Escape":
    case "Backspace":
    case "Delete":
    case "Insert":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
    case "Minus":
    case "Equal":
    case "BracketLeft":
    case "BracketRight":
    case "Semicolon":
    case "Quote":
    case "Backquote":
    case "Backslash":
    case "Comma":
    case "Period":
    case "Slash":
      return code;
    default:
      // Last-ditch fallback for any printable single character.
      if (key.length === 1) return key.toUpperCase();
      return null;
  }
}

/**
 * Pretty-print a Tauri shortcut string for display
 * ("CommandOrControl+Shift+Space" → "Ctrl + Shift + Space").
 */
function prettyHotkey(hotkey: string): string {
  return hotkey
    .split("+")
    .map((part) => {
      if (part === "CommandOrControl" || part === "Control") return "Ctrl";
      if (part === "Shift" || part === "Alt" || part === "Meta") return part;
      if (/^Key([A-Z])$/.test(part)) return part.replace("Key", "");
      if (/^Digit(\d)$/.test(part)) return part.replace("Digit", "");
      return part;
    })
    .join(" + ");
}

export default App;
