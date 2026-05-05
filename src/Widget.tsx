// Phase 10 / ADR 0014: floating widget on Windows.
// Phase 11 polish: realigned to docs/design/widget-prototype.html.
//
// Six states from docs/design/widget-design-spec.md:
//   1. default            — schema loaded, no question yet
//   2. generating         — single spinner (no token streaming, see
//                            PHASE_10_KICKOFF.md)
//   3. generated          — SQL complete + validated
//   4. validation_error   — sqlglot rejected the SQL
//   5. empty_no_schema    — first run or no extracted schema
//   6. pill               — separate render path (window resized to 220×30)
//
// Widget is read-only on configuration — adding providers, editing
// connections, redaction, and history all live in the main window. Header
// "settings" icon click opens it.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import "./widget.css";
import { tokenize } from "./SqlBlock";
import {
  IconCheckCircle,
  IconClose,
  IconCopy,
  IconError,
  IconExpandLess,
  IconProgress,
  IconRemove,
  IconSchema,
  IconSettings,
  IconSpeed,
} from "./widget-icons";
import type {
  ConnectionProfile,
  GenerationResult,
  ModelRegistry,
  ProviderConfig,
  SchemaModel,
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

const EXPANDED = { width: 400, height: 500 };
const PILL = { width: 220, height: 30 };

export function Widget() {
  const [state, setState] = useState<WidgetState>({ kind: "default" });
  const [pillMode, setPillMode] = useState(false);
  const [question, setQuestion] = useState("");
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [registry, setRegistry] = useState<ModelRegistry | null>(null);
  const [schema, setSchema] = useState<SchemaModel | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      await applyWindowSize(persisted.pill_mode);

      const reg = await invoke<ModelRegistry>("get_model_registry");
      setRegistry(reg);

      const profiles = await invoke<ConnectionProfile[]>("list_connection_profiles");
      const active = profiles[0] ?? null;
      setProfile(active);

      const activeProvider = await invoke<ProviderConfig | null>("get_active_provider");
      setProvider(activeProvider);

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

  // Autofocus textarea on every visibility change (hotkey re-summon, expand from pill).
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

  // Esc to dismiss back to tray.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void invoke("hide_widget");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function applyWindowSize(pill: boolean) {
    const dims = pill ? PILL : EXPANDED;
    try {
      await getCurrentWindow().setSize(new LogicalSize(dims.width, dims.height));
    } catch {
      // Ignore — Tauri occasionally errors mid-resize on Windows.
    }
  }

  async function collapseToPill() {
    await invoke("set_widget_pill_mode", { pillMode: true });
    setPillMode(true);
    await applyWindowSize(true);
  }

  async function expandFromPill() {
    await invoke("set_widget_pill_mode", { pillMode: false });
    setPillMode(false);
    await applyWindowSize(false);
    if (textareaRef.current) textareaRef.current.focus();
  }

  async function hideToTray() {
    await invoke("hide_widget");
  }

  async function openMainWindow() {
    await invoke("show_main_window");
  }

  async function generate() {
    if (!profile || !question.trim()) return;
    const start = performance.now();
    setState({ kind: "generating" });
    try {
      const result = await invoke<GenerationResult>("generate_sql", {
        connectionId: profile.id,
        question,
      });
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
            question,
            sql: result.sql,
            model: result.model,
            validation_status: "valid",
            validation_error: null,
          },
        });
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
            question,
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

  // ---- derived display values (used by both pill and expanded) ----

  const tableCount = schema
    ? schema.schemas.reduce(
        (acc, s) => acc + s.tables.filter((t) => !t.excluded).length,
        0,
      )
    : 0;
  const firstSchemaName = schema?.schemas[0]?.name ?? "";
  const modelDisplay = registry && provider
    ? registry.providers
        .find((p) => p.kind === provider.kind)
        ?.models.find((m) => m.id === provider.model)?.name ?? provider.model
    : "";

  // ---- pill render ----

  if (pillMode) {
    const dotClass =
      !profile || !schema
        ? "dim"
        : state.kind === "validation_error"
          ? "danger"
          : "pulse";
    return (
      <div className="pill" onDoubleClick={() => void expandFromPill()}>
        <span className={`status-dot ${dotClass}`} />
        <span>{profile?.name ?? "no connection"}</span>
        {modelDisplay && (
          <>
            <span className="sep">·</span>
            <span className="model">{modelDisplay}</span>
          </>
        )}
        <span className="pill-spacer" />
        <IconExpandLess
          className="pill-chevron"
          style={{ cursor: "pointer" }}
        />
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
          {noSchema ? (
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
                <>Try again<span className="shortcut">⌘↵</span></>
              ) : (
                <>Generate<span className="shortcut">⌘↵</span></>
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
                disabled={state.kind !== "generated"}
              />
            </div>
            <CodeBlock state={state} />
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

function CodeBlock({ state }: { state: WidgetState }) {
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
    <div className={`code-block ${state.kind === "validation_error" ? "greyed" : ""}`}>
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
