// Phase 10 / ADR 0014: floating widget on Windows.
//
// Six states from docs/design/widget-design-spec.md:
//   1. default            — schema loaded, no question yet
//   2. streaming          — implemented as a single spinner (Phase 10
//                            does not stream tokens; see PHASE_10_KICKOFF.md)
//   3. generated          — SQL complete + validated
//   4. validation_error   — sqlglot rejected the SQL
//   5. empty_no_schema    — first run or no extracted schema
//   6. pill               — separate render path (window resized to 220×30)
//
// The widget is read-only on configuration — adding providers, editing
// connections, redaction, and history all live in the main window.
// Clicking the connection / model context label opens the main window.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import "./widget.css";
import { tokenize } from "./SqlBlock";
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
  const [schemaPresent, setSchemaPresent] = useState(false);
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
      // Restore window size to whichever mode persisted.
      await applyWindowSize(persisted.pill_mode);

      const reg = await invoke<ModelRegistry>("get_model_registry");
      setRegistry(reg);

      const profiles = await invoke<ConnectionProfile[]>("list_connection_profiles");
      const active = profiles[0] ?? null;
      setProfile(active);

      const activeProvider = await invoke<ProviderConfig | null>("get_active_provider");
      setProvider(activeProvider);

      if (active) {
        const schema = await invoke<SchemaModel | null>("get_persisted_schema", {
          connectionId: active.id,
        });
        setSchemaPresent(schema !== null);
        if (!schema) {
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

  // Esc to dismiss back to tray (or pill if user prefers it).
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
          question,
          sql: result.sql,
          model: result.model,
          validationStatus: "valid",
          validationError: null,
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
          question,
          sql: result.sql,
          model: result.model,
          validationStatus: "invalid",
          validationError: message,
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

  function newQuestion() {
    setQuestion("");
    setState({ kind: "default" });
    void invoke("clear_widget_last_query");
    if (textareaRef.current) textareaRef.current.focus();
  }

  // Pill render path
  if (pillMode) {
    const status: "ready" | "no-schema" | "error" = !profile
      ? "no-schema"
      : !schemaPresent
        ? "no-schema"
        : state.kind === "validation_error"
          ? "error"
          : "ready";
    const dotClass =
      status === "error" ? "danger" : status === "no-schema" ? "dim" : "pulse";
    const modelName = registry && provider
      ? registry.providers
          .find((p) => p.kind === provider.kind)
          ?.models.find((m) => m.id === provider.model)?.name ?? provider.model
      : "";
    return (
      <div className="pill" onDoubleClick={() => void expandFromPill()}>
        <div className="pill-text">
          <span className={`status-dot ${dotClass}`} />
          <span>{profile?.name ?? "no connection"}</span>
          {modelName && <span style={{ opacity: 0.7 }}>· {modelName}</span>}
        </div>
        <button className="pill-chevron icon-btn" onClick={() => void expandFromPill()}>
          ▴
        </button>
      </div>
    );
  }

  // Expanded widget render path

  const modelDisplay = registry && provider
    ? registry.providers
        .find((p) => p.kind === provider.kind)
        ?.models.find((m) => m.id === provider.model)?.name ?? provider.model
    : "";

  const noSchema = state.kind === "empty_no_schema";
  const dotClass = noSchema
    ? "dim"
    : state.kind === "validation_error"
      ? "danger"
      : "pulse";

  return (
    <div className="widget">
      <div className="widget-header">
        <div className="widget-status-row">
          <span className={`status-dot ${dotClass}`} />
          <span className={`widget-context ${noSchema ? "dim" : ""}`}>
            {profile && schemaPresent
              ? `${profile.name} · ${modelDisplay}`
              : "no schema loaded"}
          </span>
        </div>
        <div className="widget-icons">
          <button
            className="icon-btn"
            title="Collapse to pill"
            onClick={() => void collapseToPill()}
          >
            ─
          </button>
          <button
            className="icon-btn"
            title="Open main window"
            onClick={() => void openMainWindow()}
          >
            ⚙
          </button>
          <button
            className="icon-btn"
            title="Hide to tray"
            onClick={() => void hideToTray()}
          >
            ✕
          </button>
        </div>
      </div>

      {noSchema ? (
        <EmptyNoSchema onOpenSettings={() => void openMainWindow()} />
      ) : (
        <div className="widget-body">
          <span className="field-label">Ask</span>
          <textarea
            ref={textareaRef}
            className="widget-textarea"
            placeholder="Describe the query you want…"
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
          <div className="widget-action-row">
            <span className="schema-pill">
              {profile?.dialect ?? ""}
              {profile?.database_name ? ` · ${profile.database_name}` : ""}
            </span>
            <button
              className="btn-primary"
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
                  <span className="btn-spinner" />
                  Generating
                </>
              ) : state.kind === "validation_error" ? (
                "Try again"
              ) : (
                "Generate SQL"
              )}
            </button>
          </div>

          <div className="widget-output">
            <div className="widget-output-header">
              <span className="field-label">SQL</span>
              <CopyButton
                sql={state.kind === "generated" || state.kind === "validation_error" ? state.sql : ""}
                disabled={state.kind !== "generated"}
              />
            </div>
            {state.kind === "validation_error" && state.message && (
              <div className="error-banner">{state.message}</div>
            )}
            <CodeBlock state={state} />
          </div>
        </div>
      )}

      <div className="widget-footer">
        <span>{footerLeft(state)}</span>
        <span>{footerRight(state, newQuestion)}</span>
      </div>
    </div>
  );
}

// -------- subcomponents --------

function EmptyNoSchema({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">⌗</div>
      <div className="empty-title">No schema loaded</div>
      <div style={{ fontSize: 12 }}>
        Connect to a database and extract its schema in the main window.
      </div>
      <button className="empty-link" onClick={onOpenSettings}>
        Open settings →
      </button>
    </div>
  );
}

function CodeBlock({ state }: { state: WidgetState }) {
  if (state.kind === "default") {
    return (
      <div className="widget-code-block empty">
        SQL appears here after you generate.
      </div>
    );
  }
  if (state.kind === "generating") {
    return (
      <div className="widget-code-block empty">
        Generating
        <span className="streaming-cursor">&nbsp;</span>
      </div>
    );
  }
  if (state.kind === "empty_no_schema") {
    return null;
  }
  // generated or validation_error: highlight + display
  const tokens = state.sql ? tokenize(state.sql) : [];
  return (
    <div className={`widget-code-block ${state.kind === "validation_error" ? "greyed" : ""}`}>
      {tokens.map((t, i) => (
        <span key={i} className={`tok-${t.kind}`}>
          {t.text}
        </span>
      ))}
    </div>
  );
}

function CopyButton({ sql, disabled }: { sql: string; disabled: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  async function copy() {
    if (!sql) return;
    try {
      await navigator.clipboard.writeText(sql);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1200);
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 1500);
    }
  }
  return (
    <button
      className="btn-copy"
      onClick={() => void copy()}
      disabled={disabled || !sql}
      title="Copy SQL"
    >
      {state === "copied" ? "Copied" : state === "error" ? "Failed" : "Copy"}
    </button>
  );
}

function footerLeft(state: WidgetState): string {
  switch (state.kind) {
    case "default":
      return "ready";
    case "generating":
      return "streaming · esc to cancel";
    case "generated":
      return `${state.durationMs} ms`;
    case "validation_error":
      return "rejected";
    case "empty_no_schema":
      return "no schema";
  }
}

function footerRight(state: WidgetState, onNew: () => void): React.ReactNode {
  if (state.kind === "generated") {
    return (
      <>
        <span className="footer-stat-ok">validated</span>
        {" · "}
        <button
          onClick={onNew}
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            font: "inherit",
            cursor: "pointer",
            padding: 0,
          }}
        >
          new question
        </button>
      </>
    );
  }
  if (state.kind === "validation_error") {
    return <span className="footer-stat-error">validation failed</span>;
  }
  return <span>Ctrl+Shift+Space</span>;
}
