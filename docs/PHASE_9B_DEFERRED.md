# Phase 9b — Signing and distribution (deferred)

Phase 9a (this PR) ships everything that can be built from a Windows-only
dev machine without paid accounts: the first-run onboarding wizard, the
security review PDF, the telemetry opt-in toggle, the Tauri bundle config
for cross-OS targets, and a GitHub Actions workflow that produces
**unsigned** installers on each OS.

Phase 9b is the rest of the original done-when criterion:

> A user can download the app from a clean machine, install it, follow
> onboarding to a working query, and the security team has a single PDF
> they can review.

What Phase 9a leaves open is "from a clean machine" without security
warnings, smartscreen prompts, or Gatekeeper rejection. That requires
real-world resources we don't have yet.

## What's deferred and what unblocks it

### macOS notarization

**Blocked on:** Apple Developer Program membership ($99/year), an
Apple-issued Developer ID Application certificate, and a Mac
(physical or VM with Xcode tooling) to run `codesign` + `notarytool`.

**Revisit when:** we're prepared to enroll in the Apple Developer
Program and can either rent a Mac in CI (e.g. MacStadium, GitHub Actions
macos-latest with notarization secrets) or run the notarize step on a
local Mac.

**Implementation when ready:** Tauri 2 has a built-in notarization flow.
Add `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`,
`APPLE_CERTIFICATE` (base64 .p12), and `APPLE_CERTIFICATE_PASSWORD` as
GitHub secrets. The build job on `macos-latest` reads them and signs +
notarizes during `pnpm tauri build`.

### Windows Authenticode signing

**Blocked on:** a code-signing certificate from a recognized CA (DigiCert,
Sectigo, GlobalSign — roughly $200-400/year for OV, more for EV with
hardware token).

**Revisit when:** we're ready to commit to a yearly cost and a hardware
token (EV) or HSM (OV) for the private key. EV has the SmartScreen
reputation benefit out of the gate; OV builds reputation gradually.

**Implementation when ready:** Tauri 2's Windows bundler supports
`signCommand` in `tauri.conf.json`. The signing key lives in a hardware
token connected to the build machine (or in Azure Key Vault for cloud
signing). Update the GHA workflow's Windows job to call `signtool` with
the imported certificate.

### Linux deb signing

**Blocked on:** establishing a release-signing GPG keypair, a place to
publish it (keyserver), and a hosted apt repository (or release page
with detached signatures).

**Revisit when:** we have a download story beyond "GitHub releases page."
For deb signing alone, this is the cheapest of the three (no money
required) — just operational overhead.

**Implementation when ready:** generate a release GPG key, publish the
public key, and use `dpkg-sig` or `debsigs` in the release pipeline.

### Distribution channels

**Blocked on:** signed installers — every channel below requires the
binary to be already signed.

- **Homebrew tap (macOS):** wants notarized binaries to skip Gatekeeper
  warnings. Tap repo + cask formula maintained per release.
- **winget manifest:** wants Authenticode-signed installers for the
  community-supported submission path. Microsoft also requires
  HTTPS-hosted installers; GitHub Releases works.
- **apt repository:** wants GPG-signed packages and `Release.gpg`. Can
  be hosted on GitHub Pages or any HTTPS host.

**Revisit when:** the corresponding signing story above is in place.

## What Phase 9a delivers in the meantime

- The build job in `.github/workflows/build.yml` runs on every push and
  produces unsigned `.msi` / `.exe` (Windows), `.dmg` (macOS), and
  `.AppImage` / `.deb` (Linux) artifacts. Internal contributors can
  download these from the workflow run page and smoke-test on their own
  hardware. This finally unblocks BUGS.md #10 (cross-OS verification).
- The security review PDF is reproducible on any installation —
  reviewers can verify the security claims without us shipping a signed
  binary.
- The onboarding wizard works the same on every OS, signed or not.

When Phase 9b lands, the only changes will be (a) signing config in
`tauri.conf.json` and the GHA workflow, (b) secrets in GitHub, and
(c) a release pipeline that publishes to the chosen channels. The
end-user experience stays the same; what changes is whether the
installer triggers OS warnings.
