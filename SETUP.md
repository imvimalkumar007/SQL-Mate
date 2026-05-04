# Setup guide

Steps the developer runs once on their Windows machine before opening Claude Code. Do these in order. Verify each before moving on.

## Step 1 — Install prerequisites

Install the following. After each, open a fresh PowerShell to verify with the listed command.

| Tool | Where | Verify |
|---|---|---|
| Git for Windows | https://git-scm.com/download/win | `git --version` |
| GitHub CLI (optional) | https://cli.github.com/ | `gh --version` |
| Node.js LTS | https://nodejs.org/ | `node --version` |
| pnpm | `npm install -g pnpm` | `pnpm --version` |
| Rust | https://rustup.rs/ | `rustc --version` |
| Visual Studio Build Tools | https://visualstudio.microsoft.com/visual-cpp-build-tools/ — install "Desktop development with C++" workload | (no CLI check; required for Tauri) |
| WebView2 | Pre-installed on Windows 11 / recent Win 10. Older systems: install Evergreen Bootstrapper from Microsoft. | (no CLI check) |
| gitleaks | Download Windows binary from https://github.com/gitleaks/gitleaks/releases, unzip, add to PATH | `gitleaks version` |

If any verification command fails, fix that tool before continuing.

## Step 2 — Place the project files

Unzip the handoff bundle. The unzipped folder contains `CLAUDE.md`, `README.md`, `PHASE_1_KICKOFF.md`, `SETUP.md` (this file), `.gitignore`, and `docs/`.

Move or copy that folder to wherever you want the project to live (e.g., `e:\Projects\sql-mate\`).

## Step 3 — Configure Git identity and signing

In PowerShell, replacing values with yours:

```powershell
git config --global user.name "Your Name"
git config --global user.email "your-email@example.com"
```

Check for an existing SSH key:

```powershell
ls $env:USERPROFILE\.ssh\
```

If you don't see `id_ed25519` and `id_ed25519.pub`, create one:

```powershell
ssh-keygen -t ed25519 -C "your-email@example.com"
```

Press enter through the prompts (default location, optional passphrase).

Configure git to sign with that key:

```powershell
git config --global gpg.format ssh
git config --global user.signingkey "$env:USERPROFILE\.ssh\id_ed25519.pub"
git config --global commit.gpgsign true
```

## Step 4 — Initialize the repo and run secret scan

In PowerShell, navigate to the project and initialize:

```powershell
cd "<path to your project folder>"
git init
git branch -M main
```

Run the secret scanner before the first commit:

```powershell
gitleaks detect --source . --no-git
```

Expected output: "no leaks found." If it flags anything, stop and triage — the docs should be clean.

## Step 5 — First commit

```powershell
git add .
git status
```

Verify `git status` shows: `.gitignore`, `CLAUDE.md`, `README.md`, `PHASE_1_KICKOFF.md`, `SETUP.md`, and the `docs/` tree. It should NOT show `node_modules/`, `target/`, or any `.env` file. If any of those appear, fix `.gitignore` first.

```powershell
git commit -m "phase-0: initial architecture and docs"
```

The output should mention signing with your SSH key. If git prompts about an unknown host fingerprint, confirm it.

## Step 6 — Create the GitHub repo

Open https://github.com/new in your browser:

- **Name:** `sql-mate` (or your chosen name)
- **Description:** "Local-first natural-language to SQL, with no row data exposure"
- **Visibility:** **Private**
- Do NOT add a README, .gitignore, or license — you have these locally.

Click "Create repository."

Add the remote (use the SSH URL GitHub showed you):

```powershell
git remote add origin git@github.com:<your-username>/sql-mate.git
git push -u origin main
```

If push fails because GitHub doesn't recognize your SSH key:

1. Go to https://github.com/settings/keys
2. Click "New SSH key", paste the contents of `$env:USERPROFILE\.ssh\id_ed25519.pub`, save (this is the auth key)
3. Click "New SSH key" again and add the same key as a *signing key* (separate button on the same page)
4. Retry the push

After the push succeeds, refresh the GitHub repo page. Your initial commit should show a "Verified" badge.

## Step 7 — Branch protection

On the GitHub repo:

1. Click **Settings** → **Branches**
2. Add a branch ruleset (or rule) for `main`
3. Enable: **Require a pull request before merging** and **Require signed commits**
4. Leave status checks off until CI is set up
5. Save

## Step 8 — Create the Phase 1 working branch

```powershell
git checkout -b phase-1/scaffold
git push -u origin phase-1/scaffold
```

This is the branch Claude Code will work on.

## Step 9 — Get an Anthropic API key for development

This key is for the *app* you're building, not for Claude Code itself.

1. Go to https://console.anthropic.com/
2. Sign in or create an account
3. Navigate to API Keys
4. Create a new key, name it "SQL Mate dev"
5. Copy the key somewhere safe — you won't see it again after closing the page

Don't paste it anywhere yet. You'll paste it into the Phase 1 settings field once Claude Code has built it.

## Step 10 — Open the project in Claude Code

Launch the Claude Code application. Open the project folder as the working directory.

Confirm Claude Code can see the project: ask "what files are in this directory?" — it should list `CLAUDE.md`, `README.md`, `PHASE_1_KICKOFF.md`, `SETUP.md`, `.gitignore`, and the `docs/` folder.

## Step 11 — Start Phase 1

Send this exact message to Claude Code:

> Read PHASE_1_KICKOFF.md. It tells you which other docs to read, lists the decisions already settled, and defines Phase 1's done-when. Begin Phase 1 once you have read everything it points to.

That's it. Claude Code has everything it needs.

## Step 12 — When Phase 1 is done

Phase 1 is complete when all of the done-when criteria in `PHASE_1_KICKOFF.md` are met.

Verify on your machine:

1. `pnpm tauri dev` launches the app
2. The settings field shows the "session only — not saved" banner
3. Pasting your API key and clicking the button returns generated SQL from the stub schema
4. `docs/decisions/0005-reqwest-for-http.md` exists
5. All Phase 1 commits are on `phase-1/scaffold` with `phase-1: ` prefixes

Push and open a PR:

```powershell
git push origin phase-1/scaffold
```

On GitHub:

1. Open the repo, accept the "Compare & pull request" banner
2. Title the PR "Phase 1: walking skeleton"
3. In the description, list the done-when criteria from `PHASE_1_KICKOFF.md` and check each off
4. Review your own diff. Look specifically for: any committed `.env`, any committed API key, any `node_modules/` or `target/` slipping in
5. Merge the PR
6. Delete the branch

## Troubleshooting

**`pnpm tauri dev` fails to start.** Usually a missing prerequisite from Step 1. Check the error message, install what's missing, retry. The Visual Studio Build Tools are the most common culprit on Windows.

**Git push rejected, signing key not recognized.** SSH signing key not added to GitHub as a *signing key* (separate from auth key). Go to https://github.com/settings/keys and add it.

**Claude Code doesn't seem to read CLAUDE.md.** Confirm the file is at the working directory root, not in a subfolder. Ask Claude Code to "view the file CLAUDE.md" explicitly.

**gitleaks flags something in the docs.** Tell whoever is helping you (likely a false positive on something that looks like an API key but isn't). Don't ignore it without confirming.

**Anthropic API call returns 401.** API key is invalid or wasn't pasted correctly. Generate a new one at console.anthropic.com.

**Anthropic API call returns rate limit error.** You hit the free tier limit. Add credits or wait, then retry.
