# ADR: Catspub-managed desktop accounts and model groups

- Status: Accepted for the Catspub distribution
- Date: 2026-11-16

## Context

The Catspub distribution needs site authentication, entitled model groups,
wallet information and a per-session context ceiling. The existing Desktop
supports editable provider keys and has no site account gate. New-api separates
browser authentication sessions from relay API tokens. Persisting its access
token as an editable provider key would conflate those lifecycles and expose
credentials unnecessarily.

## Decision

Add a main-process Catspub service behind additive, main-window-only IPC. The
renderer receives public account state and model metadata. The service owns
site authentication, expiry, cancellation, group discovery and relay token
lifecycle. It uses the existing Rust secret API for remembered refresh sessions
and the Rust provider API for account/group bindings. SQLite ownership and agent
execution remain in their existing processes.

Run CAPTCHA and browser-native authentication in ephemeral isolated Electron
sessions at the real Catspub origin. Do not expose Desktop preload capabilities
to remote pages. Fixed site URLs and redirect checks constrain credential
delivery. Passwords and live relay credentials stay transient.

Embed the Cap verification view in the native login form using WebContentsView.
Only main receives the CAPTCHA result; the renderer holds an opaque attempt ID.
Bound its lifetime to the form, navigation and a short expiry, and consume the
result once at password submission. OAuth and WebAuthn retain isolated windows.

Present the site's entitled groups through existing provider/model selection
interfaces, and retain models.dev for capability enrichment. Resolve relay
credentials per group only at execution time. Logout invalidates in-flight
work, closes execution transport, clears local auth, and attempts remote token
revocation using an installation-specific namespace.

Persist a nullable context ceiling on the owning session, using schema 33 and
a schema-32 backup migration. Apply it to runtime launch and context budgets,
including subagents. Preserve the full conversation transcript.

## Consequences

- This distribution requires Catspub sign-in and manages model accounts; users
  no longer manually add general chat providers through the Models page.
- Existing local projects and chats remain accessible after sign-in, including
  account switches. Provider IDs remain scoped by user and routing group.
- Offline logout clears this device but cannot promise server-side revocation.
- Unknown model metadata remains an explicit estimate until the published
  catalog supplies a matching record. Availability always comes from the site.
- There are no new third-party runtime dependencies or paid test requests.

## Alternatives

Using the entire site as the Desktop login view would inherit the web page's
navigation and credential storage lifecycle. A native form plus isolated browser
authentication keeps the app's interaction and secret boundaries explicit.
One shared provider for every group would lose group-specific routing, while
storing a relay key per group permanently would complicate account revocation.

See [product behavior](../spec/04-ux/catspub-client.md) and the Catspub E2E scenario
in [the E2E test plan](../spec/06-delivery/04-e2e-test-plan.md).
