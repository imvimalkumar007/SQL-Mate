# ADR 0009: Python sidecar lifecycle and IPC protocol

## Status

Accepted. Phase 3 commits the implementation. Phase 8 (packaging) revisits the
"system Python vs bundled Python" question.

## Context

ADR 0004 chose `sqlglot` as the SQL validator and committed us to a Python
sidecar process. Phase 3 turns that commitment into running code. We need to
decide:

1. How the Python process is spawned and supervised by the Rust core.
2. The wire protocol between Rust and Python.
3. Where Python lives during development vs. release.
4. How the sidecar handles concurrency and crashes.

## Decision

### Process management — direct `tokio::process` spawn

The Rust core spawns the Python sidecar in `tauri::Builder::setup()` using
`tokio::process::Command`. Rust holds `Child`, `ChildStdin`, and `ChildStdout`
handles. The child is set up with piped stdin/stdout/stderr so the parent can
send requests and read responses without involving the OS console.

We do not use Tauri's built-in `sidecar` config in `tauri.conf.json`. That
mechanism is designed around a single self-contained binary; Python's
"interpreter + script" model fits direct spawn better, and it gives us
explicit control over the Child lifecycle and supervision logic.

### Serialization — single `mpsc` channel

A single `tokio::sync::mpsc::Sender<SidecarRequest>` is held in the manager
and exposed to the Tauri commands via `tauri::State`. A dedicated tokio task
pulls requests from the channel one at a time, writes the JSON line to
`ChildStdin`, reads the response line from `ChildStdout`, and replies via a
oneshot channel embedded in the request. This guarantees:

- Requests serialize in order — no interleaved JSON on the pipe.
- Tauri command handlers do not race on the child handles.
- Backpressure flows naturally through the channel.

### Wire protocol — line-delimited JSON

Each message is a single line of UTF-8 JSON terminated by `\n`. Both sides
buffer per-line. No length-prefixing; no msgpack; no streaming for individual
responses.

**Startup handshake.** The first line the sidecar writes after startup is:

```json
{"ready": true, "protocol": 1, "sqlglot_version": "X.Y.Z"}
```

The Rust manager waits up to 10 seconds for this line before declaring the
sidecar usable. If timeout or wrong shape, the manager kills the child and
returns `SidecarError::Startup`.

**Validate request.** Rust → Python:

```json
{"id": "<uuid>", "kind": "validate", "dialect": "postgres", "sql": "...", "schema": {...}}
```

`schema` is the canonical `SchemaModel` JSON exactly as stored in
`schemas.model_json`. The sidecar uses it to resolve table and column
references; unknown entities are rejected per `docs/architecture/sql-validation.md`.

**Validate response — success.** Python → Rust:

```json
{"id": "<uuid>", "ok": true, "referenced_tables": ["public.customers", ...]}
```

**Validate response — failure.** Python → Rust:

```json
{
  "id": "<uuid>",
  "ok": false,
  "category": "write_statement | system_table | unknown_table | unknown_column | denylisted_function | parse_error | empty",
  "message": "human-readable reason",
  "detail": "optional context (rejected node type, names, etc.)"
}
```

**Ping.** Rust → Python:

```json
{"id": "ping", "kind": "ping"}
```

Response:

```json
{"id": "ping", "ok": true}
```

Used by the manager's optional health-check loop.

### Crash recovery — restart with backoff

If the child exits unexpectedly (read returns EOF, write fails, ping times
out), the manager:

1. Logs the exit code if available (structure-only — no SQL, no schema).
2. Closes any in-flight `oneshot` senders with `SidecarError::Crashed`.
3. Spawns a fresh child after a 200 ms delay.
4. Up to 3 consecutive restart failures, then the manager goes into a "down"
   state that returns `SidecarError::Down` until an explicit retry is
   triggered. Phase 3's UI does not implement an explicit retry button; that
   lands when the validation flow integrates with the rest of the app.

### Per-request timeout

The manager applies a 5 second timeout to every JSON round-trip. If the
sidecar takes longer, the manager treats it as crashed (kills the child and
restarts). 5 s is generous for `sqlglot` parse + AST walk on schemas with
under ~100 tables.

### Python interpreter — system Python in Phase 3, bundled in Phase 8

Phase 3 development uses whatever Python is on `PATH` (Python 3.11+). The
sidecar lives at `sidecar/main.py` at the project root, with `requirements.txt`
pinning `sqlglot` and a virtualenv at `sidecar/.venv/` (gitignored).

`dev.ps1` ensures the virtualenv exists and is on `PATH` so subsequent
`pnpm tauri dev` runs find `python.exe` with `sqlglot` installed.

Phase 8 (signed installers) replaces system Python with a stripped-down
`python-build-standalone` binary bundled in the installer per ADR 0004.
Validator behavior is unchanged; only the launch path differs.

### Concurrency

The sidecar is single-threaded by design (one mpsc consumer, one Python
process). `sqlglot` calls are CPU-bound and fast (< 100 ms typical); a single
worker keeps the implementation simple and the threat model small (no shared
state across requests inside Python, since we hand the schema in per call).

Phase 5 (large-schema retrieval) may revisit if validation latency matters
for 200-table schemas; today, single-threaded is fine.

## Rationale

- **Direct spawn over Tauri's sidecar feature.** Tauri's sidecar config
  expects a single binary in `src-tauri/binaries/`. Python is not a single
  binary and we'd be papering over that mismatch. Direct `tokio::process`
  gives us explicit Child handles and clean access to stdio.
- **mpsc serialization rather than concurrent channel access.** `sqlglot`
  parse+walk is fast; serialization adds at most a few-ms wait under load and
  drastically simplifies the manager. No need for connection pooling on a
  process boundary that handles tens of requests per minute at most.
- **Per-request schema, not a cache.** Schemas can change (re-extract). A
  cache adds invalidation logic for almost no payoff at our schema sizes.
  Sending a 50 KB JSON blob per validate is well within stdin throughput.
- **Restart-on-crash.** sqlglot bugs or weird inputs can crash the
  interpreter. Crashing the whole desktop app over that would be
  unacceptable. The sidecar boundary contains the blast.
- **Defer EXPLAIN pre-flight.** Listed in `query-execution.md` as a Phase 3
  enhancement; not on the critical path. We can add it as a follow-up
  commit. Doing it now would couple the validator and execution surfaces
  before either has settled.

## Tradeoffs accepted

- **System Python in dev means contributor friction.** A new contributor on
  a fresh Windows install needs Python 3.11+. `dev.ps1` checks for it and
  prints a useful error if missing. Phase 8 cleans this up by bundling.
- **mpsc serialization caps validation throughput at one-at-a-time.** Fine
  for an interactive desktop app; a problem nowhere near our use case
  today. If a future phase needs concurrent validations, we can spawn a
  small pool with the same channel pattern, one per worker.
- **The Python venv lives at `sidecar/.venv/` inside the repo.** Per-repo
  isolation is the right default; user can override `VIRTUAL_ENV` or point
  `dev.ps1` at a global venv. We do not commit the venv (`.gitignore`).
- **Restart counter resets only on a clean response.** If the child crashes
  three times in quick succession, the manager refuses further requests
  until process exit. This is intentional — silent flapping would leak
  validator failures into "validation passed" responses.

## Alternatives considered

- **PyO3 (in-process Python).** Rejected per ADR 0004's original analysis:
  in-process Python embedding has poor security and crash isolation, plus a
  rough cross-compilation story for Phase 8 packaging.
- **Spawn a fresh Python process per validation.** Simpler manager, but
  Python startup is 100–300 ms on Windows. That's perceptible for an
  interactive app where the user clicks "Generate" and waits.
- **Tauri's `sidecar` config in `tauri.conf.json`.** See above; mismatch with
  Python's interpreter+script model.
- **WebSocket or named pipe instead of stdin/stdout.** Adds an OS-level
  surface (port or pipe name) for no real benefit. stdin/stdout is the
  smallest possible attack surface.
- **Length-prefixed framing (e.g. msgpack with 4-byte size).** Marginally
  more efficient than line-delimited JSON for large payloads, but our
  payloads are small and JSON is debuggable by eye.

## Code locations pinned to this ADR

- `sidecar/main.py` — Python entry point.
- `sidecar/requirements.txt` — `sqlglot` pin.
- `sidecar/.venv/` — virtualenv (gitignored).
- `src-tauri/src/sidecar/mod.rs` — Rust manager.
- `src-tauri/src/sidecar/protocol.rs` — request/response types matching the
  protocol above.
- `dev.ps1` — venv bootstrap and activation.
