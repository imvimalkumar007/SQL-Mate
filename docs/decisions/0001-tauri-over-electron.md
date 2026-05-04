# ADR 0001: Tauri over Electron for the desktop shell

## Status

Accepted.

## Context

We need a cross-platform desktop application. The architecture has a small Rust core (drivers, validators, IO) and a web-based UI. Two mainstream options:

- **Electron.** Mature, large ecosystem, larger binaries (~80 MB+), uses Node.js for the backend.
- **Tauri.** Newer, Rust backend, smaller binaries (~10 MB), uses the OS's native webview for rendering.

## Decision

We use Tauri 2.x.

## Rationale

- **Binary size matters for distribution.** Security-conscious enterprise users will install the app on managed devices. A 10 MB signed binary is easier to whitelist and review than an 80 MB one.
- **Rust backend is a security win.** Memory-safe by default. The code that touches database connections, API keys, and the LLM call path benefits from the language's guarantees. We can still call Python for `sqlglot` via a sidecar; we don't lose access to that ecosystem.
- **Native OS keychain integration is well supported in Tauri.** First-party plugin (`tauri-plugin-store` or third-party `tauri-plugin-keyring`).
- **Smaller attack surface.** Tauri does not bundle a Chromium runtime. Vulnerabilities in Chromium require us to ship a full app update; with the OS webview, we benefit from OS-level browser security updates automatically.

## Tradeoffs accepted

- **Webview inconsistency across platforms.** macOS uses WebKit, Windows uses Edge WebView2, Linux uses WebKitGTK. We will hit edge-case rendering differences. Acceptable; we control the UI scope and avoid features that depend on bleeding-edge browser APIs.
- **Smaller ecosystem.** Fewer Tauri-specific examples and tutorials. Mitigated by Tauri 2.x being mature enough as of late 2025 and by the team's familiarity with Rust.
- **WebView2 dependency on Windows.** Pre-installed on Windows 11 and recent Windows 10, but we should bundle the bootstrapper for older systems.

## Alternatives considered

- **Electron.** Rejected primarily for binary size and the security posture concerns above.
- **A native UI per OS (SwiftUI / WPF / GTK).** Rejected for engineering cost. Three UIs is too much for a small team.
- **A pure CLI.** Considered. Rejected because the target user (data engineer) wants to see results in a grid and edit annotations interactively. A CLI is in scope as a secondary entry point later, not as the primary interface.
