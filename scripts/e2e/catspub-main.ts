import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { app, BrowserWindow, ipcMain, session, WebContentsView } from "electron";
import { HostProcess } from "@pi-desktop/host-runtime";
import { IPC } from "@pi-desktop/shared";
import { CatspubService } from "../../apps/desktop/electron/main/catspub/service";
import { createCatspubBrowser } from "../../apps/desktop/electron/main/catspub/browser";
import { registerCatspubIpc, assertCatspubChannel } from "../../apps/desktop/electron/main/catspub/ipc";
import { registerProviderIpc } from "../../apps/desktop/electron/main/ipc/provider-ipc";
import { createProviderCatalogRuntime } from "../../apps/desktop/electron/main/runtime/provider-catalog";
import { ModelsDevCatalog } from "../../apps/desktop/electron/main/models-dev-catalog";
import { registerBackgroundTasksIpc } from "../../apps/desktop/electron/main/ipc/background-tasks-ipc";

const root = process.env.CATSPUB_TEST_ROOT!;
const scratch = process.env.CATSPUB_TEST_DIR!;
const artifacts = process.env.CATSPUB_TEST_ARTIFACTS!;
app.setPath("userData", join(scratch, "profile"));
app.on("window-all-closed", () => {});
let window: BrowserWindow;
let host: HostProcess;
let offline = false;
let stopped = 0;
let captchaSolved = false;
let webauthnVerified = false;
let account = { id: 42, username: "alice", group: "default", quota: 1250000 };
let tokens: Array<{ id: number; name: string; group: string; status: number }> = [];
const removed: number[] = [];
const status = { password_login_enabled: true, github_oauth: true, passkey_login: true,
  captcha_enabled: true, captcha_provider: "cap_standalone_v1", captcha_public_config: { endpoint: "https://cap.catspub.com", site_key: "fixture" },
  quota_per_unit: 500000, quota_display_type: "CNY", usd_exchange_rate: 1 };
const bundle = () => ({ access_token: `fixture-access-${account.id}`, access_expires_at: Math.floor(Date.now() / 1000) + 3600,
  session: { sid: `fixture-sid-${account.id}` }, user: account });
const json = (data?: unknown, cookie = false) => Response.json({ success: true, data }, {
  headers: cookie ? { "Set-Cookie": "new_api_refresh=fixture-refresh; Path=/api/user/auth; HttpOnly; Secure; SameSite=Lax" } : {},
});
const request: typeof fetch = async (address, options) => {
  if (offline) throw new Error("Fixture offline");
  const url = new URL(String(address));
  console.log("CATSPUB_API " + url.pathname);
  assert.equal(url.origin, "https://catspub.com");
  const headers = new Headers(options?.headers);
  assert.equal(headers.get("Origin"), "https://catspub.com");
  const body = typeof options?.body === "string" ? JSON.parse(options.body) : {};
  if (url.pathname === "/api/status") return json(status);
  if (url.pathname === "/api/user/login") {
    assert.equal(body.username, "alice"); assert.equal(body.password, "fixture-password");
    assert.equal(body.remember_login, false);
    assert.equal(headers.get("X-Captcha-Token"), "fixture-captcha"); captchaSolved = true;
    return json({ require_verification: true, flow_token: "fixture-private-flow", expires_at: Math.floor(Date.now() / 1000) + 300,
      methods: [{ method: "2fa", available: true }, { method: "passkey", available: true }] });
  }
  if (url.pathname === "/api/user/login/verify") {
    assert.deepEqual(body, { flow_token: "fixture-private-flow", method: "2fa", code: "123456" });
    return json(bundle(), true);
  }
  if (url.pathname === "/api/user/auth/logout") return json();
  assert.equal(headers.get("Authorization"), `Bearer fixture-access-${account.id}`);
  if (url.pathname === "/api/user/self") return json(account);
  const groups = account.id === 42 ? { default: { desc: "Standard" }, premium: { desc: "Priority" } } : { team: { desc: "Team" } };
  if (url.pathname === "/api/user/self/groups") return json(groups);
  if (url.pathname === "/api/user/models") return json(url.searchParams.get("group") === "premium" ? ["claude-sonnet-4-20250514"] : ["gpt-4o", "site-private-model"]);
  if (url.pathname === "/api/pricing") return json([
    { model_name: "gpt-4o", supported_endpoint_types: ["openai"] },
    { model_name: "site-private-model", supported_endpoint_types: ["openai-response"] },
    { model_name: "claude-sonnet-4-20250514", supported_endpoint_types: ["anthropic"] },
  ]);
  if (url.pathname === "/api/token/search") return json({ items: tokens.filter((token) => token.name.includes(url.searchParams.get("keyword")!)) });
  if (url.pathname === "/api/token/") { tokens.push({ id: tokens.length + 1, status: 1, ...body }); return json(); }
  const key = /^\/api\/token\/(\d+)\/key$/.exec(url.pathname);
  if (key) return json({ key: `sk-fixture-${key[1]}` });
  const deletion = /^\/api\/token\/(\d+)$/.exec(url.pathname);
  if (deletion && options?.method === "DELETE") { removed.push(Number(deletion[1])); tokens = tokens.filter((token) => token.id !== Number(deletion[1])); return json(); }
  throw new Error(`Unexpected site request: ${url.pathname}`);
};

const challenge = Buffer.from("catspub-webauthn-challenge-32-bytes").toString("base64url");
const credentialId = Buffer.from("catspub-virtual-passkey");
const virtualKey = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "der" }, publicKeyEncoding: { type: "spki", format: "der" } });
app.on("session-created", (isolated) => {
  console.log("CATSPUB_SESSION_CREATED");
  // Only the auxiliary site's HTTPS network is replaced; WebAuthn still uses the real RP origin.
  isolated.protocol.handle("https", async (incoming) => {
    const url = new URL(incoming.url);
    console.log("CATSPUB_BROWSER " + url.pathname);
    if (url.origin === "https://github.com") return new Response("<script>location.assign('https://catspub.com/oauth/github?code=fixture&state=fixture')</script>", { headers: { "Content-Type": "text/html" } });
    if (url.origin !== "https://catspub.com") return new Response("", { status: 404 });
    if (url.pathname === "/sign-in") return new Response(`<!doctype html><title>Catspub</title><script>
      customElements.define('cap-widget', class extends HTMLElement {
        connectedCallback() {
          const button = document.createElement('button'); button.textContent = 'Verify';
          button.onclick = () => this.dispatchEvent(new CustomEvent('solve', { detail: { token: 'fixture-captcha' } }));
          this.append(button);
        }
      });
      if (window.piDesktop || window.catspubAuthorization) throw new Error('Desktop bridge exposed to site');
    </script>`, { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/api/oauth/state") return json({ authorization_url: "https://github.com/login/oauth/authorize?state=fixture" });
    if (url.pathname === "/oauth/github") return new Response("<script>fetch('/api/oauth/github?code=fixture&state=fixture')</script>", { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/api/oauth/github") {
      await isolated.cookies.set({ url: "https://catspub.com/api/user/auth/refresh", name: "new_api_refresh", value: "browser-fixture", path: "/api/user/auth", secure: true, httpOnly: true });
      return json(bundle(), true);
    }
    if (url.pathname === "/api/user/passkey/login/begin") {
      const auxiliary = BrowserWindow.getAllWindows().find((candidate) => candidate !== window)!;
      const debug = auxiliary.webContents.debugger;
      await debug.sendCommand("WebAuthn.enable", { enableUI: false });
      const { authenticatorId } = await debug.sendCommand("WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
      } });
      await debug.sendCommand("WebAuthn.addCredential", { authenticatorId, credential: {
        credentialId: credentialId.toString("base64"), isResidentCredential: true, rpId: "catspub.com",
        privateKey: virtualKey.privateKey.toString("base64"), signCount: 0, userHandle: Buffer.from("88").toString("base64"),
      } });
      return json({ flow_token: "fixture-passkey-flow", options: { publicKey: { challenge, rpId: "catspub.com", userVerification: "required",
        allowCredentials: [{ type: "public-key", id: credentialId.toString("base64url") }] } } });
    }
    if (url.pathname === "/api/user/passkey/login/finish") {
      const body = await incoming.json();
      assert.equal(body.flow_token, "fixture-passkey-flow");
      assert.equal(body.credential.id, credentialId.toString("base64url"));
      const clientData = JSON.parse(Buffer.from(body.credential.response.clientDataJSON, "base64url").toString());
      assert.equal(clientData.origin, "https://catspub.com"); assert.equal(clientData.challenge, challenge);
      webauthnVerified = true;
      return json(bundle(), true);
    }
    return new Response("", { status: 404 });
  });
});
app.on("browser-window-created", (_event, created) => {
  console.log("CATSPUB_WINDOW_CREATED " + created.getTitle());
  if (created.getTitle() !== "Catspub E2E") created.hide();
  created.webContents.on("console-message", (event) => console.log("CATSPUB_RENDERER " + event.message));
});

void app.whenReady().then(async () => {
try {
  host = new HostProcess({ binaryPath: join(root, "target/debug/pi-desktop-host-core.exe"), dataDir: join(scratch, "host-data"), onStderr() {} });
  await host.handshake();
  await host.call("app.getVersion");
  window = new BrowserWindow({ title: "Catspub E2E", show: false, width: 1080, height: 780,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(root, "apps/desktop/out/preload/index.cjs") } });
  const models = new ModelsDevCatalog({ catalogPath: join(root, "apps/desktop/resources/models.dev/api.json") });
  const service = new CatspubService({ call: (method, params) => host.call(method, params as any), models,
    browser: createCatspubBrowser(() => window), request, stopWork: async () => { stopped++; } });
  const wrap = async (fn: () => unknown) => {
    try { return { ok: true, data: await fn() }; }
    catch (error: any) { return { ok: false, error: { code: error.errorCode ?? error.data?.errorCode ?? "INTERNAL", message: error.message } }; }
  };
  const registrar: any = {
    ipcMain,
    handle: (channel: string, handler: (...args: any[]) => unknown) => ipcMain.handle(channel, (_event, ...args) => wrap(() => { assertCatspubChannel(service, channel); return handler(...args); })),
    handleWithEvent: (channel: string, handler: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => wrap(() => handler(event, ...args))),
    assertMainWindowSender: (event: Electron.IpcMainInvokeEvent) => assert.equal(event.sender, window.webContents),
  };
  registerCatspubIpc(registrar, service);
  registerBackgroundTasksIpc({ registrar, getHost: () => host as any });
  registrar.handle(IPC.invoke.composerCommands, () => ({ commands: [] }));
  registrar.handle(IPC.invoke.liveVoiceStatus, () => ({ enabled: false, settingsRevision: 0, bindings: [], call: null }));
  registrar.handle(IPC.invoke.todosGet, (input: { sessionId: string }) => host.call("todos.get", input));
  registrar.handle(IPC.invoke.modesRunGet, (sessionId: string) => host.call("modes.get", { sessionId }));
  registrar.handle(IPC.invoke.windowControl, async () => ({ maximized: window.isMaximized() }));
  const catalog = createProviderCatalogRuntime({ getHost: () => host as any, modelsDevCatalog: models, siteProviders: () => service.listProviders() });
  registerProviderIpc({ catspub: service, registrar, getHost: () => host as any, modelsDevCatalog: models,
    vendorOAuth: {} as any, logger: { app() {} } as any, ...catalog });
  for (const [channel, method] of [[IPC.invoke.sessionList, "session.list"], [IPC.invoke.sessionGet, "session.get"],
    [IPC.invoke.sessionCreate, "session.create"], [IPC.invoke.settingsGet, "settings.get"], [IPC.invoke.appGetOnboarding, "app.getOnboarding"]]) {
    registrar.handle(channel, (params: any) => host.call(method, params));
  }
  registrar.handle(IPC.invoke.sessionConfigure, (id: string, params: any) => host.call("session.configure", { id, ...params }));
  const probe = (expression: string) => window.webContents.executeJavaScript(`catspubProbe.${expression}`);
  const assertInlineBounds = async (view: WebContentsView) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const bounds = await probe("captchaBounds()");
      if (isDeepStrictEqual(view.getBounds(), bounds)) return;
      if (Date.now() > deadline) assert.deepEqual(view.getBounds(), bounds);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const solveInlineCaptcha = async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const view = window.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView);
      if (view && !view.webContents.isDestroyed() && !view.webContents.isLoading()) {
        const ready = await view.webContents.executeJavaScript('Boolean(document.querySelector("cap-widget button"))').catch(() => false);
        if (ready) {
          assert.equal(BrowserWindow.getAllWindows().length, 1, "CAPTCHA must not open another window");
          assert.equal(await view.webContents.executeJavaScript('Boolean(window.piDesktop)'), false);
          assert.equal(new URL(view.webContents.getURL()).origin, "https://catspub.com");
          await assertInlineBounds(view);
          await probe("captchaReflow(true)");
          await assertInlineBounds(view);
          await probe("captchaReflow(false)");
          await assertInlineBounds(view);
          await view.webContents.executeJavaScript('document.querySelector("cap-widget button").click()');
          await probe("captchaReady()");
          assert.equal(window.contentView.children.length, 0, "Solved CAPTCHA must release its view");
          return;
        }
      }
      if (Date.now() > deadline) throw new Error("Inline CAPTCHA did not mount");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const capture = async (name: string) => {
    const layout = await probe("layout()");
    assert.deepEqual(layout.overflow, [], JSON.stringify(layout)); assert.equal(layout.pageOverflow, false);
    const image = await window.webContents.capturePage();
    assert(image.toBitmap().some((value, index) => index % 4 !== 3 && value !== 255), "Screenshot must not be blank");
    await writeFile(join(artifacts, `${name}.png`), image.toPNG());
  };
  await window.loadFile(join(scratch, "index.html"));
  const initial = await probe("initial()");
  assert.equal(initial.remember, false); assert(initial.logo > 0); await capture("login-desktop");
  window.setContentSize(420, 800); await capture("login-narrow"); window.setContentSize(1080, 780);
  await solveInlineCaptcha();
  const first = await probe("password()");
  assert.equal(captchaSolved, true); assert.equal(first.groups.length, 2);
  const chrome = await probe("chrome()");
  assert.equal(chrome.brand, "Pi-Desktop[Catspub]"); assert.equal(chrome.brandFits, true);
  assert.equal(chrome.footerVersion, false); assert.equal(chrome.modelVisible, true);
  assert.deepEqual((await probe('context("32000")')).disabled, ["256000", "1000000"]);
  const saved: any = await host.call("session.get", { id: first.sessionId });
  assert.equal(saved.session.contextWindowLimit, 32000);
  const profile = await probe("profile()");
  assert(profile.includes("alice") && profile.includes("42") && profile.includes("2.5")); await capture("profile-desktop");
  account = { ...account, quota: 2000000 };
  assert((await probe('refreshProfile("4")')).includes("CNY"));
  await probe("closeProfile()");
  const groupNames = await probe("modelGroups()");
  assert(groupNames.some((name: string) => name.includes("default")) && groupNames.some((name: string) => name.includes("premium")));
  await capture("model-picker-desktop");
  const selected = await probe('selectGroupModel("premium · Priority", "claude-sonnet-4-20250514")');
  assert.equal(selected.context, 32000);
  await probe('reasoning("medium")');
  const composer = await probe("chrome()");
  assert.equal(composer.model, "claude-sonnet-4-20250514");
  assert.equal(composer.level, "medium"); assert.equal(composer.levelVisible, true); assert.equal(composer.labelsOverlap, false);
  await capture("models-desktop");
  window.setContentSize(420, 800);
  const narrow = await probe("chrome()");
  assert.equal(narrow.modelVisible, true); assert.equal(narrow.levelVisible, true); assert.equal(narrow.labelsOverlap, false);
  await capture("composer-narrow"); window.setContentSize(1080, 780);
  const [provider] = await service.listProviders(); await service.resolveAuth(provider.id);
  assert.deepEqual(await host.call("secrets.has", { secretRef: "secret:catspub:remembered-session" }), { has: false });
  offline = true;
  const signedOut = await probe("logout()");
  assert.equal(signedOut.providers, 0); assert(signedOut.message?.includes("本机")); assert.equal(stopped, 1);
  offline = false; account = { id: 77, username: "github-user", group: "team", quota: 500000 };
  const second = await probe('browser("GitHub")');
  assert.deepEqual(second.groups, ["team · Team"]); assert(second.providerIds.every((id: string) => !first.providerIds.includes(id)));
  const oldModels = await window.webContents.executeJavaScript(`window.piDesktop.invoke(${JSON.stringify(IPC.invoke.providersListModels)}, {providerId:${JSON.stringify(first.providerIds[0])},source:'cache'})`);
  assert.deepEqual(oldModels.data.models, []);
  const history: any = await host.call("session.list"); assert(history.sessions.some((row: any) => row.id === first.sessionId));
  await probe("logout()");
  account = { id: 88, username: "passkey-user", group: "team", quota: 500000 };
  await probe('browser("Passkey")'); assert.equal(webauthnVerified, true);
  window.setContentSize(420, 800); await capture("models-narrow");
  await probe("profile()"); await capture("profile-narrow");
  await probe("logout()");
  service.cancel();
  assert.equal(window.contentView.children.length, 0, "Cancelled CAPTCHA must release its view");
  window.destroy();
  await host.dispose();
  console.log(`CATSPUB_E2E ${JSON.stringify({ login: "password+captcha+mfa", github: true, passkey: "virtual authenticator at catspub.com", context: 32000, sharedHistory: true, offlineLogout: true, brandedSidebar: true, visibleModelAndReasoning: true, screenshots: 8 })}`);
  app.quit();
} catch (error: any) {
  console.log("CATSPUB_WINDOWS " + JSON.stringify(BrowserWindow.getAllWindows().map((item) => ({ title: item.getTitle(), url: item.webContents.getURL(), loading: item.webContents.isLoading(), debug: item.webContents.debugger.isAttached() }))));
  console.error("CATSPUB_E2E_ERROR " + String(error.stack ?? error));
  if (window && !window.isDestroyed()) {
    const screenshot = await window.webContents.capturePage().catch(() => undefined);
    if (screenshot) await writeFile(join(artifacts, "failure.png"), screenshot.toPNG());
  }
  await host?.dispose();
  console.error("CATSPUB_E2E_ERROR " + String(error.stack ?? error)); app.exit(1);
}
});
