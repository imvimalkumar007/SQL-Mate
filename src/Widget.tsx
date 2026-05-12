// Phase 10 / ADR 0014: floating widget on Windows.
// Phase 11 polish: realigned to docs/design/widget-prototype.html.
// Phase 12 / ADR 0015: multi-database connection picker.
//
// Eight states from docs/design/widget-design-spec.md:
//   1. default            — schema loaded, no question yet
//   2. generating         — single spinner (no token streaming)
//   3. generated          — SQL complete + validated
//   4. validation_error   — sqlglot rejected the SQL
//   5. empty_no_schema    — first run or no extracted schema
//   6. pill               — separate render path (window resized to 220×30)
//   7. (picker open)      — overlaid on any of the above via pickerOpen flag
//   8. (after switch)     — generated/error state with sqlIsStale=true
//
// Widget is read-only on configuration — adding providers, editing
// connections, redaction, and history all live in the main window. Header
// "settings" icon click opens it.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/window";
import "./widget.css";
import { tokenize } from "./SqlBlock";
import {
  IconCheck,
  IconCheckCircle,
  IconClose,
  IconCopy,
  IconError,
  IconExpandLess,
  IconExpandMore,
  IconHistory,
  IconInfo,
  IconProgress,
  IconRefresh,
  IconRemove,
  IconSchema,
  IconSettings,
  IconSpeed,
} from "./widget-icons";
import type {
  ConnectionProfile,
  GenerationResult,
  HistoryEntry,
  ModelRegistry,
  ProviderConfig,
  SchemaModel,
  SessionTurn,
  ValidatedSql,
} from "./types";

type WidgetState =
  | { kind: "default" }
  | { kind: "generating" }
  | { kind: "generated"; sql: string; model: string; durationMs: number; referenced: string[] }
  | { kind: "validation_error"; sql: string; model: string; message: string }
  | { kind: "empty_no_schema" };

type PersistedState = {
  position_x: number | null;
  position_y: number | null;
  last_question: string | null;
  last_sql: string | null;
  last_model: string | null;
  last_validation_status: string | null;
  last_validation_error: string | null;
  pill_mode: boolean;
};

function formatSchemaAge(extractedAt: number): string {
  const diff = Math.floor(Date.now() / 1000) - extractedAt;
  const days = Math.floor(diff / 86400);
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor(diff / 60);
  if (days > 0) return `extracted ${days} day${days === 1 ? "" : "s"} ago`;
  if (hours > 0) return `extracted ${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (minutes > 0) return `extracted ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return "extracted just now";
}

export function Widget() {
  const [state, setState] = useState<WidgetState>({ kind: "default" });
  const [pillMode, setPillMode] = useState(false);
  const [question, setQuestion] = useState("");
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [allProfiles, setAllProfiles] = useState<ConnectionProfile[]>([]);
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [registry, setRegistry] = useState<ModelRegistry | null>(null);
  const [schema, setSchema] = useState<SchemaModel | null>(null);
  const [schemaAges, setSchemaAges] = useState<Record<string, number | null>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sqlIsStale, setSqlIsStale] = useState(false);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  // ADR 0017: opt-in session context + follow-up suggestions
  const [sessionContextEnabled, setSessionContextEnabled] = useState(false);
  const [followupSuggestionsEnabled, setFollowupSuggestionsEnabled] = useState(false);
  const [widgetSessionHistory, setWidgetSessionHistory] = useState<SessionTurn[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Initial load + restore.
  useEffect(() => {
    void (async () => {
      const persisted = await invoke<PersistedState>("get_widget_state");
      setPillMode(persisted.pill_mode);
      if (persisted.position_x !== null && persisted.position_y !== null) {
        try {
          await getCurrentWindow().setPosition(
            new PhysicalPosition(persisted.position_x, persisted.position_y),
          );
        } catch {
          // Ignore — position restoration is best-effort across monitor changes.
        }
      }

      const reg = await invoke<ModelRegistry>("get_model_registry");
      setRegistry(reg);

      // ADR 0017: load opt-in settings
      const sessionCtx = await invoke<boolean>("get_session_context_enabled");
      setSessionContextEnabled(sessionCtx);
      const followupSugg = await invoke<boolean>("get_followup_suggestions_enabled");
      setFollowupSuggestionsEnabled(followupSugg);

      const profileList = await invoke<ConnectionProfile[]>("list_connection_profiles");
      setAllProfiles(profileList);
      const active = profileList[0] ?? null;
      setProfile(active);

      const activeProvider = await invoke<ProviderConfig | null>("get_active_provider");
      setProvider(activeProvider);

      // Load schema ages for all profiles (lightweight — only the timestamp).
      const ages: Record<string, number | null> = {};
      for (const p of profileList) {
        ages[p.id] = await invoke<number | null>("get_schema_extracted_at", {
          connectionId: p.id,
        });
      }
      setSchemaAges(ages);

      if (active) {
        const fresh = await invoke<SchemaModel | null>("get_persisted_schema", {
          connectionId: active.id,
        });
        setSchema(fresh);
        if (!fresh) {
          setState({ kind: "empty_no_schema" });
        } else if (persisted.last_question && persisted.last_sql) {
          setQuestion(persisted.last_question);
          if (persisted.last_validation_status === "valid") {
            setState({
              kind: "generated",
              sql: persisted.last_sql,
              model: persisted.last_model ?? "",
              durationMs: 0,
              referenced: [],
            });
          } else if (persisted.last_validation_status === "invalid") {
            setState({
              kind: "validation_error",
              sql: persisted.last_sql,
              model: persisted.last_model ?? "",
              message: persisted.last_validation_error ?? "Validation failed.",
            });
          }
        }
      } else {
        setState({ kind: "empty_no_schema" });
      }
    })();
  }, []);

  // Autofocus textarea on every visibility change.
  useEffect(() => {
    if (pillMode) return;
    const win = getCurrentWindow();
    const unlistens: Array<() => void> = [];
    void (async () => {
      const focusUnlisten = await win.onFocusChanged(({ payload: focused }) => {
        if (focused && textareaRef.current) textareaRef.current.focus();
      });
      unlistens.push(focusUnlisten);
    })();
    if (textareaRef.current) textareaRef.current.focus();
    return () => unlistens.forEach((fn) => fn());
  }, [pillMode]);

  // Persist position whenever the user moves the window.
  useEffect(() => {
    const win = getCurrentWindow();
    const cleanups: Array<() => void> = [];
    let cancelled = false;
    void (async () => {
      const moveUnlisten = await win.onMoved(({ payload: pos }) => {
        if (cancelled) return;
        void invoke("set_widget_position", { x: pos.x, y: pos.y });
      });
      cleanups.push(moveUnlisten);
    })();
    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  // Listen for "show widget" from the tray / hotkey.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("widget://focus", () => {
      if (textareaRef.current) textareaRef.current.focus();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Esc: close the picker if open, otherwise dismiss to tray.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pickerOpen) {
          setPickerOpen(false);
        } else if (historyOpen) {
          setHistoryOpen(false);
        } else {
          void invoke("hide_widget");
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pickerOpen]);

  // Close picker on click outside.
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  async function collapseToPill() {
    await invoke("set_widget_pill_mode", { pillMode: true });
    setPillMode(true);
  }

  async function expandFromPill() {
    await invoke("set_widget_pill_mode", { pillMode: false });
    setPillMode(false);
    if (textareaRef.current) textareaRef.current.focus();
  }

  async function hideToTray() {
    await invoke("hide_widget");
  }

  async function openMainWindow() {
    await invoke("show_main_window");
  }

  async function switchConnection(newProfile: ConnectionProfile) {
    setPickerOpen(false);
    if (newProfile.id === profile?.id) return;

    // Reset session history on connection switch — context from a different
    // schema is not useful and could confuse the LLM (ADR 0017).
    setWidgetSessionHistory([]);
    setSuggestions([]);
    setHistoryOpen(false);
    setHistoryEntries([]);

    // Mark current SQL stale before switching away.
    const hadSql = state.kind === "generated" || state.kind === "validation_error";

    setProfile(newProfile);

    const fresh = await invoke<SchemaModel | null>("get_persisted_schema", {
      connectionId: newProfile.id,
    });
    setSchema(fresh);

    if (!fresh) {
      setSqlIsStale(false);
      setState({ kind: "empty_no_schema" });
    } else {
      if (hadSql) {
        setSqlIsStale(true);
        // Keep the current state (generated/validation_error) so the stale
        // SQL remains visible with the "from previous connection" label.
      } else {
        setSqlIsStale(false);
        setState({ kind: "default" });
      }
    }
  }

  async function refreshSchema(profileId: string, e: React.MouseEvent) {
    e.stopPropagation();
    setRefreshingIds((prev) => new Set(prev).add(profileId));
    try {
      await invoke("extract_schema", { connectionId: profileId });
      const now = Math.floor(Date.now() / 1000);
      setSchemaAges((prev) => ({ ...prev, [profileId]: now }));
      // If this is the active connection, also refresh the loaded schema.
      if (profileId === profile?.id) {
        const fresh = await invoke<SchemaModel | null>("get_persisted_schema", {
          connectionId: profileId,
        });
        setSchema(fresh);
        if (fresh && state.kind === "empty_no_schema") {
          setState({ kind: "default" });
        }
      }
    } catch {
      // Silently ignore — the stale badge remains; user can retry.
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
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

  async function openHistory() {
    if (!profile) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const entries = await invoke<HistoryEntry[]>("list_history", {
        connectionId: profile.id,
        limit: 50,
      });
      setHistoryEntries(entries);
    } catch {
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  function useHistoryEntry(entry: HistoryEntry) {
    setQuestion(entry.question);
    setHistoryOpen(false);
    // Focus the textarea so the user can adjust or immediately generate.
    window.setTimeout(() => textareaRef.current?.focus(), 50);
  }

  // Accepts an optional override question so suggestion chips can fire
  // generation immediately without waiting for setQuestion to flush (ADR 0017).
  async function generate(overrideQuestion?: string) {
    const q = overrideQuestion ?? question;
    if (!profile || !q.trim()) return;
    if (overrideQuestion) setQuestion(overrideQuestion);
    setSqlIsStale(false);
    setSuggestions([]);
    setSuggestionsLoading(false);
    const start = performance.now();
    setState({ kind: "generating" });

    // Build session history when context is enabled (ADR 0017).
    const historyForBackend: SessionTurn[] = sessionContextEnabled
      ? [...widgetSessionHistory]
      : [];

    try {
      const result = await invoke<GenerationResult>("generate_sql", {
        connectionId: profile.id,
        question: q,
        sessionHistory: historyForBackend.length > 0 ? historyForBackend : null,
      });

      // Push this turn to local session history.
      setWidgetSessionHistory((prev) => [
        ...prev,
        { question: q, sql: result.sql },
      ]);

      try {
        const v = await invoke<ValidatedSql>("validate_sql", {
          connectionId: profile.id,
          sql: result.sql,
          historyId: result.history_id,
        });
        const durationMs = Math.round(performance.now() - start);
        setState({
          kind: "generated",
          sql: result.sql,
          model: result.model,
          durationMs,
          referenced: v.referenced_tables,
        });
        await invoke("set_widget_last_query", {
          req: {
            question: q,
            sql: result.sql,
            model: result.model,
            validation_status: "valid",
            validation_error: null,
          },
        });

        // Fetch follow-up suggestions in the background (ADR 0017).
        if (followupSuggestionsEnabled) {
          setSuggestionsLoading(true);
          void invoke<string[]>("get_followup_suggestions", {
            connectionId: profile.id,
            question: q,
            sql: result.sql,
          })
            .then((s) => setSuggestions(s))
            .catch(() => setSuggestions([]))
            .finally(() => setSuggestionsLoading(false));
        }
      } catch (e) {
        const message = String(e);
        setState({
          kind: "validation_error",
          sql: result.sql,
          model: result.model,
          message,
        });
        await invoke("set_widget_last_query", {
          req: {
            question: q,
            sql: result.sql,
            model: result.model,
            validation_status: "invalid",
            validation_error: message,
          },
        });
      }
    } catch (e) {
      setState({
        kind: "validation_error",
        sql: "",
        model: "",
        message: String(e),
      });
    }
  }

  // ---- derived display values ----

  const tableCount = schema
    ? schema.schemas.reduce(
        (acc, s) => acc + s.tables.filter((t) => !t.excluded).length,
        0,
      )
    : 0;
  const firstSchemaName = schema?.schemas[0]?.name ?? "";
  const modelDisplay =
    registry && provider
      ? registry.providers
          .find((p) => p.kind === provider.kind)
          ?.models.find((m) => m.id === provider.model)?.name ?? provider.model
      : "";
  const multipleProfiles = allProfiles.length > 1;

  // ---- pill render ----

  if (pillMode) {
    const dotClass =
      !profile || !schema
        ? "dim"
        : state.kind === "validation_error"
          ? "danger"
          : "pulse";
    return (
      <div className="pill">
        <span className={`status-dot ${dotClass}`} />
        <span>{profile?.name ?? "no connection"}</span>
        {modelDisplay && (
          <>
            <span className="sep">·</span>
            <span className="model">{modelDisplay}</span>
          </>
        )}
        <span className="pill-spacer" />
        <button
          type="button"
          className="pill-chevron-btn"
          title="Expand widget"
          onClick={() => void expandFromPill()}
        >
          <IconExpandLess className="pill-chevron" />
        </button>
      </div>
    );
  }

  // ---- expanded render ----

  const noSchema = state.kind === "empty_no_schema";
  const isErrorState = state.kind === "validation_error";
  const dotClass = noSchema ? "dim" : isErrorState ? "danger" : "pulse";

  return (
    <div className={`widget${isErrorState ? " error-state" : ""}`}>
      <div className="widget-header">
        <div className="widget-header-left">
          <span className={`status-dot ${dotClass}`} />

          {multipleProfiles ? (
            // Connection picker button — replaces the static context label.
            <div ref={pickerRef} style={{ display: "contents" }}>
              <button
                className={`conn-picker-btn${pickerOpen ? " open" : ""}`}
                onClick={() => setPickerOpen((o) => !o)}
                title="Switch connection"
              >
                <span className="conn-picker-name">
                  {noSchema && !profile ? "no connection" : (profile?.name ?? "no connection")}
                </span>
                {pickerOpen ? <IconExpandLess /> : <IconExpandMore />}
              </button>
              {modelDisplay && (
                <span className="context-label">
                  <span className="sep">·</span>
                  <span className="model">{modelDisplay}</span>
                </span>
              )}
            </div>
          ) : noSchema ? (
            <span className="context-label dim">no schema loaded</span>
          ) : (
            <span className="context-label">
              {profile?.name ?? "no connection"}
              {modelDisplay && (
                <>
                  <span className="sep">·</span>
                  <span className="model">{modelDisplay}</span>
                </>
              )}
            </span>
          )}
        </div>
        <div className="widget-header-right">
          <button
            className="icon-btn"
            title="Minimize to pill"
            onClick={() => void collapseToPill()}
          >
            <IconRemove />
          </button>
          {profile && (
            <button
              className={`icon-btn${historyOpen ? " icon-btn--active" : ""}`}
              title="Query history"
              onClick={() => historyOpen ? setHistoryOpen(false) : void openHistory()}
            >
              <IconHistory />
            </button>
          )}
          <button
            className="icon-btn"
            title="Open main window"
            onClick={() => void openMainWindow()}
          >
            <IconSettings />
          </button>
          <button
            className="icon-btn"
            title="Hide to tray"
            onClick={() => void hideToTray()}
          >
            <IconClose />
          </button>
        </div>
      </div>

      {/* Connection picker dropdown — overlays the body when open */}
      {pickerOpen && multipleProfiles && (
        <div className="conn-menu" ref={pickerRef}>
          {allProfiles.map((p) => {
            const isActive = p.id === profile?.id;
            const age = schemaAges[p.id];
            const hasSchema = age !== null && age !== undefined;
            const isStale = hasSchema && Math.floor(Date.now() / 1000) - age! > 7 * 86400;
            const isRefreshing = refreshingIds.has(p.id);

            return (
              <div
                key={p.id}
                className={`conn-menu-item${isActive ? " active" : ""}`}
                onClick={() => void switchConnection(p)}
              >
                <div className="conn-menu-item-info">
                  <div className={`conn-item-name${!hasSchema ? " dim" : ""}`}>
                    {p.name}
                  </div>
                  <div
                    className={`conn-item-age${isStale ? " stale" : ""}${!hasSchema ? " italic" : ""}`}
                  >
                    {hasSchema ? formatSchemaAge(age!) : "no schema yet"}
                  </div>
                </div>
                {isActive && <IconCheck className="conn-item-check" size={14} />}
                {isStale && !isActive && (
                  <button
                    className="conn-refresh-btn"
                    title={`Refresh ${p.name} schema`}
                    onClick={(e) => void refreshSchema(p.id, e)}
                  >
                    {isRefreshing ? (
                      <IconProgress className="spin" />
                    ) : (
                      <IconRefresh />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {noSchema ? (
        <div className="widget-body">
          <div className="empty-state">
            <IconSchema className="empty-state-icon" />
            <div className="empty-state-title">No schema loaded</div>
            <div className="empty-state-desc">
              Connect a database and extract its schema in the main window
              before asking questions here.
            </div>
            <button className="empty-state-link" onClick={() => void openMainWindow()}>
              Open settings →
            </button>
          </div>
        </div>
      ) : historyOpen ? (
        <div className="widget-body">
          <HistoryPanel
            entries={historyEntries}
            loading={historyLoading}
            onUse={useHistoryEntry}
            onClose={() => setHistoryOpen(false)}
          />
        </div>
      ) : (
        <div className="widget-body">
          <label className="field-label">Ask</label>
          <textarea
            ref={textareaRef}
            className="question-input"
            placeholder="Ask about your schema…"
            value={question}
            disabled={state.kind === "generating"}
            onChange={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void generate();
              }
            }}
          />

          {/* Feature toggles — visible so they're discoverable in the primary UI */}
          <div className="widget-toggles">
            <button
              className={`widget-toggle${sessionContextEnabled ? " on" : ""}`}
              onClick={() => void toggleSessionContext()}
              title="When on, sends your last 5 Q+SQL pairs so you can ask follow-ups."
            >
              Context {sessionContextEnabled ? "ON" : "OFF"}
            </button>
            <button
              className={`widget-toggle${followupSuggestionsEnabled ? " on" : ""}`}
              onClick={() => void toggleFollowupSuggestions()}
              title="When on, shows 3 suggested follow-up questions after each query."
            >
              Suggestions {followupSuggestionsEnabled ? "ON" : "OFF"}
            </button>
          </div>

          <div className="action-row">
            <span className="schema-pill">
              <IconSchema />
              {firstSchemaName}
              {tableCount > 0 && ` · ${tableCount} table${tableCount === 1 ? "" : "s"}`}
            </span>
            <button
              className="generate-btn"
              onClick={() => void generate()}
              disabled={
                state.kind === "generating" ||
                !question.trim() ||
                !profile ||
                !provider
              }
            >
              {state.kind === "generating" ? (
                <>
                  <IconProgress className="spin" />
                  Generating
                </>
              ) : isErrorState ? (
                <>Try again<span className="shortcut">Ctrl ↵</span></>
              ) : (
                <>Generate<span className="shortcut">Ctrl ↵</span></>
              )}
            </button>
          </div>

          {isErrorState && state.message && (
            <div className="error-banner">
              <IconError />
              <div>
                <strong>Validation failed</strong>
                <span className="err-detail">{state.message}</span>
              </div>
            </div>
          )}

          <div className="output-section">
            <div className="output-header">
              <label className="field-label" style={{ marginBottom: 0 }}>
                {isErrorState ? "Generated (rejected)" : "SQL"}
              </label>
              <CopyButton
                sql={
                  state.kind === "generated" || state.kind === "validation_error"
                    ? state.sql
                    : ""
                }
                disabled={state.kind !== "generated" || sqlIsStale}
              />
            </div>
            {sqlIsStale && (
              <div className="stale-sql-notice">
                <IconInfo />
                from previous connection
              </div>
            )}
            <CodeBlock state={state} stale={sqlIsStale} />

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
                    disabled={state.kind === "generating"}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="widget-footer">
        <div className="footer-left">
          <FooterLeft state={state} />
        </div>
        <FooterRight state={state} />
      </div>
    </div>
  );
}

// -------- subcomponents --------

function CodeBlock({ state, stale }: { state: WidgetState; stale: boolean }) {
  if (state.kind === "default") {
    return (
      <div className="code-block empty">
        SQL appears here after you generate.
      </div>
    );
  }
  if (state.kind === "generating") {
    return (
      <div className="code-block">
        <span className="cursor" />
      </div>
    );
  }
  if (state.kind === "empty_no_schema") {
    return null;
  }
  // generated or validation_error
  const tokens = state.sql ? tokenize(state.sql) : [];
  return (
    <div
      className={[
        "code-block",
        state.kind === "validation_error" ? "greyed" : "",
        stale ? "stale" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {tokens.map((t, i) => (
        <span key={i} className={`tok-${t.kind}`}>
          {t.text}
        </span>
      ))}
    </div>
  );
}

function CopyButton({ sql, disabled }: { sql: string; disabled: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  async function copy() {
    if (!sql) return;
    try {
      await navigator.clipboard.writeText(sql);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1500);
    }
  }
  return (
    <button
      className="copy-btn"
      onClick={() => void copy()}
      disabled={disabled || !sql}
      title="Copy SQL"
    >
      <IconCopy />
      {copyState === "copied" ? "Copied" : copyState === "error" ? "Failed" : "Copy"}
    </button>
  );
}

function FooterLeft({ state }: { state: WidgetState }) {
  switch (state.kind) {
    case "default":
      return <span className="footer-stat">ready</span>;
    case "generating":
      return <span className="footer-stat streaming">generating</span>;
    case "generated":
      return (
        <span className="footer-stat">
          <IconSpeed />
          {state.durationMs}ms
        </span>
      );
    case "validation_error":
      return <span className="footer-stat rejected">rejected</span>;
    case "empty_no_schema":
      return <span className="footer-stat">setup needed</span>;
  }
}

function FooterRight({ state }: { state: WidgetState }) {
  if (state.kind === "generated") {
    return (
      <span className="footer-stat validated">
        <IconCheckCircle />
        validated
      </span>
    );
  }
  if (state.kind === "generating") {
    return <span className="footer-stat">esc to cancel</span>;
  }
  return <span className="footer-stat">esc to dismiss</span>;
}

function formatHistoryAge(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function HistoryPanel({
  entries,
  loading,
  onUse,
  onClose,
}: {
  entries: HistoryEntry[];
  loading: boolean;
  onUse: (e: HistoryEntry) => void;
  onClose: () => void;
}) {
  return (
    <div className="history-panel">
      <div className="history-panel-header">
        <span className="field-label" style={{ marginBottom: 0 }}>Recent queries</span>
        <button className="history-panel-back" onClick={onClose} title="Back (Esc)">
          ✕ close
        </button>
      </div>

      {loading && (
        <span className="suggestions-loading">loading…</span>
      )}

      {!loading && entries.length === 0 && (
        <div className="history-panel-empty">No queries yet for this connection.</div>
      )}

      {!loading && entries.length > 0 && (
        <ul className="history-panel-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                className="history-panel-item"
                onClick={() => onUse(entry)}
                title="Click to use this question"
              >
                <div className="history-panel-question">{entry.question}</div>
                <div className="history-panel-meta">
                  <span>{formatHistoryAge(entry.asked_at)}</span>
                  {entry.validation_status === "valid" ? (
                    <span className="history-panel-ok">✓ valid</span>
                  ) : (
                    <span className="history-panel-err">✗ rejected</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
