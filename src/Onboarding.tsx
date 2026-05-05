// Phase 9: first-run onboarding wizard.
//
// Replaces the "drop the user into five empty cards" first-run experience
// with a guided welcome → provider setup → connection setup → optional
// schema extract → done flow. Reuses the existing Tauri commands (no new
// backend surface for onboarding itself, only mark_onboarding_completed
// at the end).
//
// The wizard is opt-out: the welcome and done screens both have a "Skip
// onboarding" button that marks onboarding completed without finishing
// the steps. Users who skip land on the main screen with empty cards,
// which is the pre-Phase-9 experience.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  ModelRegistry,
  ProviderConfig,
  ProviderKind,
} from "./types";

type Dialect = "postgres" | "mysql";

type ProviderForm = {
  name: string;
  kind: ProviderKind;
  base_url: string;
  model: string;
  api_key: string;
};

type ConnectionForm = {
  name: string;
  dialect: Dialect;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
};

type Step = "welcome" | "provider" | "connection" | "schema" | "done";

type Props = {
  registry: ModelRegistry | null;
  onComplete: () => void;
};

export function Onboarding({ registry, onComplete }: Props) {
  const [step, setStep] = useState<Step>("welcome");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provider step
  const firstProvider = registry?.providers[0] ?? null;
  const [provider, setProvider] = useState<ProviderForm>({
    name: firstProvider?.name ?? "Anthropic",
    kind: firstProvider?.kind ?? "anthropic",
    base_url: firstProvider?.default_base_url ?? "https://api.anthropic.com",
    model:
      firstProvider?.models.find((m) => m.recommended_for === "default")?.id ??
      firstProvider?.models[0]?.id ??
      "",
    api_key: "",
  });
  const [savedProvider, setSavedProvider] = useState<ProviderConfig | null>(null);

  // Connection step
  const [conn, setConn] = useState<ConnectionForm>({
    name: "",
    dialect: "postgres",
    host: "localhost",
    port: "5432",
    database: "",
    username: "",
    password: "",
  });
  const [savedProfile, setSavedProfile] = useState<ConnectionProfile | null>(null);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  async function skip() {
    await invoke("mark_onboarding_completed");
    onComplete();
  }

  async function saveProvider() {
    setBusy(true);
    setError(null);
    try {
      const created = await invoke<ProviderConfig>("create_provider_config", {
        req: provider,
      });
      setSavedProvider(created);
      setStep("connection");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setTestStatus(null);
    try {
      const port = parseInt(conn.port, 10);
      if (Number.isNaN(port)) throw new Error("port must be a number");
      await invoke("test_connection", {
        req: {
          dialect: conn.dialect,
          host: conn.host,
          port,
          database: conn.database,
          username: conn.username,
          password: conn.password,
        },
      });
      setTestStatus({ ok: true, msg: "Connection OK." });
    } catch (e) {
      setTestStatus({ ok: false, msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function saveConnection() {
    setBusy(true);
    setError(null);
    try {
      const port = parseInt(conn.port, 10);
      if (Number.isNaN(port)) throw new Error("port must be a number");
      const created = await invoke<ConnectionProfile>("create_connection_profile", {
        req: {
          name: conn.name || `${conn.host}:${port}/${conn.database}`,
          dialect: conn.dialect,
          host: conn.host,
          port,
          database: conn.database,
          username: conn.username,
          password: conn.password,
        },
      });
      setSavedProfile(created);
      setStep("schema");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function extractNow() {
    if (!savedProfile) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("extract_schema", { connectionId: savedProfile.id });
      setStep("done");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await invoke("mark_onboarding_completed");
      onComplete();
    } finally {
      setBusy(false);
    }
  }

  const providerOptions = registry?.providers ?? [];

  return (
    <main className="container">
      <div className="onboarding">
        <div className="onboarding-progress">
          <Step label="Welcome" active={step === "welcome"} done={stepIndex(step) > 0} />
          <Step label="LLM provider" active={step === "provider"} done={stepIndex(step) > 1} />
          <Step label="Database" active={step === "connection"} done={stepIndex(step) > 2} />
          <Step label="Schema" active={step === "schema"} done={stepIndex(step) > 3} />
          <Step label="Done" active={step === "done"} done={false} />
        </div>

        {error && <div className="status status-error">{error}</div>}

        {step === "welcome" && (
          <section className="card">
            <h1>Welcome to SQL Mate</h1>
            <p>
              SQL Mate turns natural-language questions into SQL queries
              against your database. Three things make it different:
            </p>
            <ul>
              <li>
                <strong>Row data never leaves your machine.</strong> The LLM
                only sees schema metadata — table and column names, types,
                and any notes you write.
              </li>
              <li>
                <strong>You bring your own LLM key.</strong> Requests go
                directly from your machine to Anthropic, OpenAI, or any
                OpenAI-compatible endpoint you configure. We're not in the
                middle.
              </li>
              <li>
                <strong>Generated SQL is read-only by construction.</strong>
                {" "}Every query is parsed and validated before you see it.
                You always click run yourself.
              </li>
            </ul>
            <p className="muted small">
              The next steps will set up your first LLM provider and your
              first database connection. You can skip and configure
              everything from the main screen instead.
            </p>
            <div className="row">
              <button onClick={() => setStep("provider")} disabled={busy}>
                Continue
              </button>
              <button className="link" onClick={() => void skip()}>
                Skip onboarding
              </button>
            </div>
          </section>
        )}

        {step === "provider" && (
          <section className="card">
            <h2>Step 1 of 3 — Configure an LLM provider</h2>
            <p className="muted small">
              We need an API key from one provider to generate SQL. The key
              is stored in the SQLCipher-encrypted local store on this
              machine and never sent anywhere except to the provider you
              pick.
            </p>
            <div className="row">
              <label className="grow">
                Provider
                <select
                  value={provider.kind}
                  onChange={(e) => {
                    const kind = e.currentTarget.value as ProviderKind;
                    const reg = providerOptions.find((p) => p.kind === kind);
                    setProvider({
                      ...provider,
                      kind,
                      name: reg?.name ?? provider.name,
                      base_url: reg?.default_base_url ?? provider.base_url,
                      model:
                        reg?.models.find((m) => m.recommended_for === "default")?.id ??
                        reg?.models[0]?.id ??
                        "",
                    });
                  }}
                >
                  {providerOptions.map((p) => (
                    <option key={p.id} value={p.kind}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grow">
                Model
                <select
                  value={provider.model}
                  onChange={(e) => setProvider({ ...provider, model: e.currentTarget.value })}
                >
                  {providerOptions
                    .find((p) => p.kind === provider.kind)
                    ?.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} · {m.cost_tier} cost
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label>
              API key
              <input
                type="password"
                value={provider.api_key}
                placeholder="sk-..."
                onChange={(e) =>
                  setProvider({ ...provider, api_key: e.currentTarget.value })
                }
              />
            </label>
            <label>
              Friendly name
              <input
                value={provider.name}
                onChange={(e) =>
                  setProvider({ ...provider, name: e.currentTarget.value })
                }
              />
            </label>
            <div className="row">
              <button
                onClick={() => void saveProvider()}
                disabled={busy || !provider.api_key.trim() || !provider.model.trim()}
              >
                {busy ? "Saving…" : "Save and continue"}
              </button>
              <button className="link" onClick={() => setStep("welcome")}>
                Back
              </button>
              <button className="link" onClick={() => void skip()}>
                Skip onboarding
              </button>
            </div>
          </section>
        )}

        {step === "connection" && (
          <section className="card">
            <h2>Step 2 of 3 — Connect to a database</h2>
            <p className="muted small">
              Use credentials that are <strong>read-only at the database
              layer</strong>. The app enforces read-only at the application
              layer too, but the DB role is the primary control.
            </p>
            <div className="row">
              <label className="grow">
                Dialect
                <select
                  value={conn.dialect}
                  onChange={(e) => {
                    const dialect = e.currentTarget.value as Dialect;
                    setConn({
                      ...conn,
                      dialect,
                      port: dialect === "mysql" ? "3306" : "5432",
                    });
                  }}
                >
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL / MariaDB</option>
                </select>
              </label>
              <label className="port">
                Port
                <input
                  value={conn.port}
                  onChange={(e) => setConn({ ...conn, port: e.currentTarget.value })}
                />
              </label>
            </div>
            <label>
              Host
              <input
                value={conn.host}
                onChange={(e) => setConn({ ...conn, host: e.currentTarget.value })}
              />
            </label>
            <label>
              Database
              <input
                value={conn.database}
                onChange={(e) => setConn({ ...conn, database: e.currentTarget.value })}
              />
            </label>
            <div className="row">
              <label className="grow">
                Username
                <input
                  value={conn.username}
                  onChange={(e) => setConn({ ...conn, username: e.currentTarget.value })}
                />
              </label>
              <label className="grow">
                Password
                <input
                  type="password"
                  value={conn.password}
                  onChange={(e) => setConn({ ...conn, password: e.currentTarget.value })}
                />
              </label>
            </div>
            <label>
              Friendly name
              <input
                value={conn.name}
                placeholder="e.g. analytics warehouse"
                onChange={(e) => setConn({ ...conn, name: e.currentTarget.value })}
              />
            </label>
            {testStatus && (
              <div className={testStatus.ok ? "status status-ok" : "status status-error"}>
                {testStatus.msg}
              </div>
            )}
            <div className="row">
              <button type="button" onClick={() => void testConnection()} disabled={busy} className="secondary">
                {busy ? "Testing…" : "Test connection"}
              </button>
              <button onClick={() => void saveConnection()} disabled={busy}>
                Save and continue
              </button>
              <button className="link" onClick={() => setStep("provider")}>
                Back
              </button>
              <button className="link" onClick={() => void skip()}>
                Skip onboarding
              </button>
            </div>
          </section>
        )}

        {step === "schema" && (
          <section className="card">
            <h2>Step 3 of 3 — Extract your schema (optional)</h2>
            <p>
              SQL Mate reads only metadata: table names, column names, types,
              keys. It runs one query against <code>information_schema</code>
              and stores the result locally. You can do this now or later
              from the main screen.
            </p>
            <div className="row">
              <button onClick={() => void extractNow()} disabled={busy}>
                {busy ? "Extracting…" : "Extract now"}
              </button>
              <button className="secondary" onClick={() => setStep("done")} disabled={busy}>
                Skip for now
              </button>
              <button className="link" onClick={() => setStep("connection")}>
                Back
              </button>
            </div>
          </section>
        )}

        {step === "done" && (
          <section className="card">
            <h2>You're set up</h2>
            <p>
              {savedProvider && savedProfile ? (
                <>
                  <strong>{savedProvider.name}</strong> is configured for SQL
                  generation. <strong>{savedProfile.name}</strong> is your
                  database connection.
                </>
              ) : (
                "Click finish to start asking questions."
              )}
            </p>
            <p className="muted small">
              You can change providers, connections, and redaction settings
              at any time from the main screen.
            </p>
            <div className="row">
              <button onClick={() => void finish()} disabled={busy}>
                Finish
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function Step({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className={`onboarding-step${active ? " active" : ""}${done ? " done" : ""}`}>
      <span className="step-bullet">{done ? "✓" : "•"}</span>
      <span className="step-label">{label}</span>
    </div>
  );
}

function stepIndex(step: Step): number {
  return ["welcome", "provider", "connection", "schema", "done"].indexOf(step);
}
