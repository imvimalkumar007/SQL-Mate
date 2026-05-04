import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [apiKey, setApiKey] = useState("");
  const [sql, setSql] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSql("");
    setLoading(true);
    try {
      // TODO(phase-4): move to OS keychain via tauri-plugin-keyring
      const result = await invoke<string>("generate_sql", { apiKey });
      setSql(result);
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>SQL Mate</h1>
      <p className="subtitle">
        Phase 1 walking skeleton. Hardcoded schema, hardcoded question, your API key.
      </p>

      <div className="banner" role="status">
        <strong>Phase 1 development build.</strong> API key is held in memory only,
        cleared on close. Keychain integration ships in a later phase.
      </div>

      <form className="form" onSubmit={handleGenerate}>
        <label htmlFor="api-key">Anthropic API key</label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
          placeholder="sk-ant-..."
        />
        <button type="submit" disabled={loading || apiKey.trim() === ""}>
          {loading ? "Generating…" : "Generate SQL"}
        </button>
      </form>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {sql && (
        <section className="output">
          <div className="output-label">Generated SQL</div>
          <pre>{sql}</pre>
        </section>
      )}
    </main>
  );
}

export default App;
