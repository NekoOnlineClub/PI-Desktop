# Catspub Desktop Account and Model Selection

This distribution signs in to `https://catspub.com` using the authentication
contracts in the accompanying new-api service. The desktop workspace is gated
until authentication succeeds. Local projects and conversation history remain
on the device and are shared across site account switches.

## Sign In

- Read `/api/status` for available password, GitHub and Passkey methods.
- Password sign-in honors the site's RSA-OAEP/AES-GCM password encryption
  contract, CAPTCHA policy and second-factor challenge. Verification supports
  authenticator/recovery codes and Passkey when the challenge permits them.
- Cap CAPTCHA runs in an isolated HTTPS view embedded in the login form, with
  no separate window or Desktop preload bridge. Main owns its short-lived,
  single-use result; the renderer receives only an opaque completion ID.
  Failed, cancelled and expired attempts release the view and permit retry.
  GitHub and WebAuthn use temporary isolated windows on the site's real origin.
- Remember login is off by default. Passwords, access tokens and relay keys
  never enter renderer state, preferences, logs or model bindings. When selected,
  remember login stores only the refresh session in the existing Host secret
  store. Refresh rotates the stored session through the same secret boundary.
- Cancellation invalidates pending operations. Expired/revoked sessions return
  to sign-in. A temporary catalog failure permits retry after a successful login.
- Windows/Linux retain the existing minimize, maximize and close controls on
  the sign-in screen.

## Available Models

The site's `/api/user/self/groups` response supplies routing groups. Fetch
`/api/user/models?group=...` for every permitted group and intersect with supported
chat endpoint types from `/api/pricing`. Display models under their site group
in the existing composer picker and the Settings Models directory.

The site supplies model availability and routing. The bundled models.dev catalog
supplies known model limits and capabilities, never additional selectable IDs.
Unknown models use a clearly marked estimated 128K context/8K output fallback.
OpenAI chat completions, OpenAI Responses and Anthropic Messages are supported.
Endpoints that only provide images, audio or embeddings do not become chat models.

Group bindings persist in Rust-owned provider records keyed by user and group.
Only the active account's current directory is exposed to consumers. Managed
bindings cannot be manually edited or replaced through provider IPC. Relay keys
are resolved lazily for a group when execution actually needs credentials.

## Context Tiers

The composer offers Auto, 32K, 64K, 128K, 256K and 1M. Tiers above the selected
model's limit are disabled. The effective context window is the smaller of the
session tier and the model's limit; Auto uses the model's limit. Switching to a
smaller model preserves the selected preference while applying the smaller cap.

`SessionSummary.contextWindowLimit` is optional; `null` clears the preference.
The setting follows draft creation, session configuration, history reads, forks
and restart. Main execution, context inspection, compaction and subagent launch
receive the effective limit. Output budgets remain bounded by that context.

Storage schema 33 adds nullable `sessions.context_window_limit` and a check for
the supported values. Existing schema-32 databases are backed up and upgraded;
existing sessions default to Auto. The JSON-RPC protocol remains version 11
because the session field and Desktop IPC channels are additive. The shared
schema constant now matches the Rust schema version.

## Profile and Sign Out

The sidebar heading reads `Pi-Desktop[Catspub]`. Its bottom action bar does not
display a version number; version details and updates remain in Settings/About.
The composer keeps the selected model name beside its enabled reasoning level,
including narrow chat columns. The toolbar wraps when needed instead of hiding
these labels. Truncated model names remain available in the trigger's tooltip.

The bottom-left profile button opens an anchored dialog with username, user ID,
wallet balance/currency, Refresh and Sign out. Balance is computed using the
site's quota unit and currency settings. Refresh updates both wallet and models.

Sign out immediately gates the renderer, invalidates pending account operations,
clears the account catalog and refresh secret, and stops active execution. It
attempts to revoke only this installation's managed relay tokens and its auth
session. Offline failures report local completion; they cannot guarantee remote
revocation. Local projects and conversation history are retained.

## Verification

`node --test apps/desktop/test/catspub-service.test.mjs` covers authentication,
directory entitlement, relay credentials, expiry, cancellation, logout and the
actual launch/compaction budget. Shared contract tests cover context semantics.
Host tests cover upgrades, backups, validation, configuration, forks and restart.
`pnpm test:e2e:catspub` drives the production components and IPC against a real
Rust Host and isolated database, replacing only external site HTTP responses.
No real account or paid model call is needed.

## Run From Source on Windows

After building the JavaScript workspaces and host-core, run `Start-Catspub.cmd`
from the repository root. It opens the built Electron client and uses the
existing development storage profile, separate from an installed release.
It does not rebuild the application. Dependencies and build outputs must remain
available beside the source tree.
