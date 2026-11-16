import assert from "node:assert/strict";
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(root, "apps/desktop/.catspub-service-test-"));
after(() => rm(temp, { recursive: true, force: true }));
await build({
  entryPoints: {
    service: join(root, "apps/desktop/electron/main/catspub/service.ts"),
    api: join(root, "apps/desktop/electron/main/catspub/api.ts"),
    models: join(root, "apps/desktop/electron/main/models-dev-catalog.ts"),
    stop: join(root, "apps/desktop/electron/main/catspub/stop-work.ts"),
    launch: join(root, "apps/desktop/electron/main/runtime/session-launch.ts"),
    catalog: join(root, "apps/desktop/electron/main/runtime/provider-catalog.ts"),
    budget: join(root, "packages/agent-runtime/src/context-budget.ts"),
  },
  outdir: temp, outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", format: "esm", packages: "external",
  nodePaths: [join(root, "apps/desktop/node_modules")],
});
const load = (name) => import(pathToFileURL(join(temp, `${name}.mjs`)).href);
const { CatspubService } = await load("service");
const { CatspubApi, encryptSitePassword } = await load("api");
const { ModelsDevCatalog } = await load("models");
const { stopCatspubWork } = await load("stop");
const { createSessionLaunchRuntime } = await load("launch");
const { createProviderCatalogRuntime } = await load("catalog");
const { contextBudgetLimitsFor } = await load("budget");
const AUTH_REF = "secret:catspub:remembered-session";
const INSTALL_REF = "secret:installation:oauth-device-id";
const deferred = () => Promise.withResolvers();
const ok = (data, cookie) => Response.json({ success: true, data }, {
  headers: cookie ? { "Set-Cookie": `new_api_refresh=${cookie}; Path=/api/user/auth; HttpOnly; Secure; SameSite=Lax` } : {},
});
const models = new ModelsDevCatalog({ catalogPath: join(root, "apps/desktop/resources/models.dev/api.json") });

function fixture() {
  const f = {
    secrets: new Map([[INSTALL_REF, "aabbccdd-1234-4567-8910-112233445566"]]),
    providers: [], requests: [], tokens: [], deleted: [], stopped: 0, now: Date.now(),
    status: { password_login_enabled: true, quota_per_unit: 500000, quota_display_type: "CNY", usd_exchange_rate: 7 },
    user: { id: 42, username: "alice", group: "default", quota: 1250000 },
    groups: { default: { desc: "Standard" }, premium: { desc: "Priority" } },
    groupModels: { default: ["gpt-4o", "private-model", "image-only"], premium: ["claude-sonnet-4-20250514", "response-only"] },
    pricing: [
      { model_name: "gpt-4o", supported_endpoint_types: ["openai"] },
      { model_name: "private-model", supported_endpoint_types: ["openai"] },
      { model_name: "claude-sonnet-4-20250514", supported_endpoint_types: ["anthropic", "openai"] },
      { model_name: "response-only", supported_endpoint_types: ["openai-response"] },
      { model_name: "image-only", supported_endpoint_types: ["image-generation"] },
      { model_name: "not-permitted", supported_endpoint_types: ["openai"] },
    ],
  };
  f.bundle = () => ({ access_token: `access-${f.user.id}`, access_expires_at: Math.floor(f.now / 1000) + 3600,
    session: { sid: `sid-${f.user.id}` }, user: { ...f.user } });
  f.call = async (method, input = {}) => {
    if (method === "secrets.getForRuntime") return { value: f.secrets.get(input.secretRef) };
    if (method === "secrets.set") { f.secrets.set(input.secretRef, input.value); return {}; }
    if (method === "secrets.delete") { f.secrets.delete(input.secretRef); return {}; }
    if (method === "providers.list") return { providers: f.providers };
    if (method === "providers.create") {
      const provider = { ...input, id: `provider-${f.providers.length + 1}`, enabled: true, hasSecret: false };
      f.providers.push(provider); return { provider };
    }
    if (method === "providers.update") {
      const provider = f.providers.find((row) => row.id === input.id);
      Object.assign(provider, input); return { provider };
    }
    throw new Error(`Unexpected Host boundary: ${method}`);
  };
  f.request = async (address, options) => {
    const url = new URL(address);
    assert.equal(url.origin, "https://catspub.com");
    assert.equal(options.redirect, "error");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("Origin"), "https://catspub.com");
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    const path = url.pathname;
    f.requests.push({ path, body, headers, method: options.method });
    if (f.offline) throw new Error("secret backend error that must never cross IPC");
    if (path === "/api/status") return ok(f.status);
    if (path === "/api/user/login/encryption-key") return ok(f.encryptionKey);
    if (path === "/api/user/login") return f.loginResponse ? f.loginResponse(body, headers) : ok(f.bundle(), "refresh-login");
    if (path === "/api/user/login/verify") return ok(f.bundle(), "refresh-mfa");
    if (path === "/api/user/auth/refresh") {
      if (f.refreshResponse) return f.refreshResponse(body, headers);
      return ok(f.bundle(), "refresh-rotated");
    }
    if (path === "/api/user/auth/logout") return ok();
    assert.equal(headers.get("Authorization"), `Bearer access-${f.user.id}`);
    assert.equal(headers.get("X-Auth-Session"), `sid-${f.user.id}`);
    assert.equal(headers.get("Cookie"), null, "refresh cookies only go to the auth path");
    if (path === "/api/user/self") return f.selfResponse ? f.selfResponse() : ok(f.user);
    if (path === "/api/user/self/groups") {
      if (f.directoryUnavailable) throw new Error("offline");
      return ok(f.groups);
    }
    if (path === "/api/pricing") return ok(f.pricing);
    if (path === "/api/user/models") return ok(f.groupModels[url.searchParams.get("group")] ?? []);
    if (path === "/api/token/search") {
      const items = f.tokens.filter((token) => token.name.includes(url.searchParams.get("keyword")));
      const page = Number(url.searchParams.get("p"));
      return ok({ items: items.slice((page - 1) * 100, page * 100) });
    }
    if (path === "/api/token/") {
      if (f.createGate) { f.createEntered.resolve(); await f.createGate.promise; }
      f.tokens.push({ id: f.tokens.length + 1, status: 1, ...body }); return ok();
    }
    const key = /^\/api\/token\/(\d+)\/key$/.exec(path);
    if (key) return ok({ key: `sk-relay-${key[1]}` });
    const token = /^\/api\/token\/(\d+)$/.exec(path);
    if (token && options.method === "DELETE") { f.deleted.push(Number(token[1])); return ok(); }
    throw new Error(`Unexpected HTTP boundary: ${path}`);
  };
  f.browser = {
    updateCaptcha() {},
    async captcha(status, signal) { assert.equal(status.captcha_enabled, true); assert.equal(signal.aborted, false); return "cap-solved"; },
    async login(method, remember, signal, challenge) {
      f.browserInput = { method, remember, signal, challenge };
      return { bundle: f.bundle(), refreshCookie: "browser-refresh" };
    },
  };
  f.service = () => new CatspubService({ call: f.call, models, request: f.request, browser: f.browser,
    stopWork: async () => { f.stopped++; }, now: () => f.now });
  f.login = async (service, rememberLogin = false) => {
    await service.initialize();
    const captchaId = f.status.captcha_enabled ? "fixture-captcha" : undefined;
    if (captchaId) await service.startCaptcha({ id: captchaId, bounds: { x: 10, y: 20, width: 320, height: 80 }, theme: "dark" });
    return service.login({ username: " alice ", password: "correct-password", rememberLogin, captchaId });
  };
  return f;
}

test("password encryption matches new-api RSA and hybrid v2 contracts", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const decrypt = (value, label) => privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", ...(label ? { oaepLabel: Buffer.from(label) } : {}) }, Buffer.from(value, "base64"));
  const key = { kid: "test-key", public_key: pair.publicKey };
  assert.equal(decrypt(encryptSitePassword("short password", key).password_encrypted).toString(), "short password");
  const long = "long password ".repeat(100);
  const encrypted = encryptSitePassword(long, key);
  assert.equal(encrypted.encryption_key_id, key.kid);
  const [version, wrapped, nonce, payload] = encrypted.password_encrypted.split(".");
  assert.equal(version, "v2");
  const data = Buffer.from(payload, "base64");
  const cipher = createDecipheriv("aes-256-gcm", decrypt(wrapped, "password-v2"), Buffer.from(nonce, "base64"));
  cipher.setAAD(Buffer.from(`password-v2:${key.kid}`)); cipher.setAuthTag(data.subarray(-16));
  assert.equal(Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString(), long);
});

test("native login uses status encryption, CAPTCHA and MFA without exposing credentials", async () => {
  const f = fixture();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  Object.assign(f.status, { password_login_encryption_enabled: true, captcha_enabled: true });
  f.encryptionKey = { kid: "native", public_key: pair.publicKey };
  f.loginResponse = (body, headers) => {
    assert.equal(body.username, "alice"); assert.equal(body.remember_login, false);
    assert.equal(body.password, undefined); assert.ok(body.password_encrypted);
    assert.equal(headers.get("X-Captcha-Token"), "cap-solved");
    return ok({ require_verification: true, flow_token: "private-flow", expires_at: Math.floor(f.now / 1000) + 300, methods: [{ method: "2fa", available: true }, { method: "passkey", available: true }] });
  };
  const service = f.service();
  const pending = await f.login(service);
  assert.equal(pending.status, "verification");
  assert.equal(JSON.stringify(pending).includes("private-flow"), false);
  const signedIn = await service.verify("123456");
  assert.equal(signedIn.status, "authenticated");
  assert.equal(signedIn.profile.balance, 17.5); assert.equal(signedIn.profile.currency, "CNY");
  assert.equal(signedIn.profile.id, 42); assert.equal(signedIn.profile.username, "alice");
  assert.equal(f.secrets.has(AUTH_REF), false);
  assert.deepEqual(f.requests.find((request) => request.path.endsWith("/verify")).body, { flow_token: "private-flow", method: "2fa", code: "123456" });
  assert.equal(/access-42|sid-42|refresh-mfa|private-flow/.test(JSON.stringify(signedIn)), false);
});

test("cancel rejects a late login response and never remembers it", async () => {
  const f = fixture(); const service = f.service();
  const entered = deferred(); const late = deferred();
  f.loginResponse = async () => { entered.resolve(); return late.promise; };
  const login = f.login(service, true);
  await entered.promise;
  assert.equal(service.cancel().status, "anonymous");
  late.resolve(ok(f.bundle(), "too-late"));
  await assert.rejects(login, { errorCode: "CATSPUB_CANCELLED" });
  assert.equal(service.isAuthenticated(), false); assert.equal(f.secrets.has(AUTH_REF), false);
});

test("inline CAPTCHA is opaque, single use, expires, and cannot be reused after cancellation", async () => {
  const f = fixture(); f.status.captcha_enabled = true;
  const service = f.service(); await service.initialize();
  const request = { id: "inline-one", bounds: { x: 10, y: 20, width: 320, height: 80 }, theme: "dark" };
  const login = () => service.login({ username: "alice", password: "correct-password", rememberLogin: false, captchaId: request.id });
  const result = await service.startCaptcha(request);
  assert.deepEqual(result, { ready: true });
  assert.equal(JSON.stringify(service.view()).includes("cap-solved"), false);
  service.cancelCaptcha("old-request");
  assert.equal((await login()).status, "authenticated");
  await service.logout();
  await assert.rejects(login(), { errorCode: "CATSPUB_CAPTCHA_REQUIRED" });
  service.cancel();
  await service.startCaptcha(request);
  f.now += 240001;
  await assert.rejects(login(), { errorCode: "CATSPUB_CAPTCHA_REQUIRED" });
  service.cancel();
  await service.startCaptcha(request); service.cancelCaptcha(request.id);
  await assert.rejects(login(), { errorCode: "CATSPUB_CAPTCHA_REQUIRED" });
});

test("late inline CAPTCHA completion cannot resurrect a cancelled attempt", async () => {
  const f = fixture(); f.status.captcha_enabled = true;
  const entered = deferred(); const late = deferred();
  let signal;
  f.browser.captcha = async (_status, pendingSignal) => { signal = pendingSignal; entered.resolve(); return late.promise; };
  const service = f.service(); await service.initialize();
  const pending = service.startCaptcha({ id: "cancel-inline", bounds: { x: 10, y: 20, width: 320, height: 80 }, theme: "dark" });
  await entered.promise; service.cancel(); assert.equal(signal.aborted, true);
  late.resolve("cap-solved");
  await assert.rejects(pending, { errorCode: "CATSPUB_CANCELLED" });
  assert.equal(service.isAuthenticated(), false);
  assert.equal(f.requests.some((request) => request.path === "/api/user/login"), false);
});

test("directory is limited to actual routing groups and permitted chat model ids", async () => {
  const f = fixture(); const service = f.service(); await f.login(service);
  const providers = await service.listProviders();
  assert.deepEqual(providers.map((provider) => provider.name), ["default · Standard", "premium · Priority"]);
  assert.deepEqual(providers.flatMap((provider) => provider.models.map((model) => model.id)), ["gpt-4o", "private-model", "claude-sonnet-4-20250514", "response-only"]);
  assert.equal(providers.every((provider) => provider.authKind === "catspub" && provider.hasSecret), true);
  assert.equal(providers[0].models[1].contextWindowEstimated, true);
  assert.equal(providers[0].models[0].contextWindowEstimated, false);
  assert.equal((await service.bindingFor(providers[1].id, "claude-sonnet-4-20250514")).apiStyle, "anthropic_messages");
  assert.equal((await service.bindingFor(providers[1].id, "response-only")).apiStyle, "responses");
  await assert.rejects(service.bindingFor(providers[0].id, "not-permitted"), { errorCode: "CATSPUB_MODEL_UNAVAILABLE" });
  assert.equal(f.tokens.length, 0, "browsing models never creates billable relay credentials");
});

test("relay credentials are lazy, coalesced per group, reused and already sk-prefixed", async () => {
  const f = fixture(); const service = f.service(); await f.login(service);
  const [provider] = await service.listProviders();
  const credentials = await Promise.all(Array.from({ length: 8 }, () => service.resolveAuth(provider.id)));
  assert.deepEqual(credentials, Array.from({ length: 8 }, () => ({ apiKey: "sk-relay-1" })));
  assert.equal(f.tokens.length, 1); assert.equal(f.tokens[0].group, "default");
  assert.equal(f.tokens[0].name.length <= 50, true);
  const reopened = f.service(); await f.login(reopened);
  assert.deepEqual(await reopened.resolveAuth(provider.id), { apiKey: "sk-relay-1" });
  assert.equal(f.tokens.length, 1);
});

test("remembered refresh rotates securely and expiry refresh is singleflight", async () => {
  const f = fixture(); const first = f.service(); await f.login(first, true);
  assert.deepEqual(JSON.parse(f.secrets.get(AUTH_REF)), { refreshCookie: "refresh-login", sid: "sid-42" });
  const restored = f.service(); assert.equal((await restored.initialize()).status, "authenticated");
  assert.equal(JSON.parse(f.secrets.get(AUTH_REF)).refreshCookie, "refresh-rotated");
  const refresh = f.requests.find((request) => request.path === "/api/user/auth/refresh");
  assert.equal(refresh.headers.get("Cookie"), "new_api_refresh=refresh-login");
  assert.equal(refresh.headers.get("X-Auth-Session"), "sid-42");
  f.now += 3600 * 1000;
  const before = f.requests.filter((request) => request.path === "/api/user/auth/refresh").length;
  await Promise.all(Array.from({ length: 8 }, () => restored.listProviders()));
  assert.equal(f.requests.filter((request) => request.path === "/api/user/auth/refresh").length - before, 1);
});

test("logout waits for an admitted token creation then revokes only installation-owned tokens", async () => {
  const f = fixture(); const service = f.service(); await f.login(service, true);
  const [provider] = await service.listProviders();
  f.createGate = deferred(); f.createEntered = deferred();
  const auth = service.resolveAuth(provider.id);
  const rejectedAuth = assert.rejects(auth, { errorCode: "CATSPUB_CANCELLED" });
  await f.createEntered.promise;
  const logout = service.logout();
  assert.equal(service.isAuthenticated(), false);
  const admittedName = f.requests.find((request) => request.path === "/api/token/").body.name;
  const prefix = admittedName.slice(0, -12);
  for (let index = 0; index < 105; index++) f.tokens.push({ id: index + 1, status: 1, group: "default", name: prefix + (index + 1).toString(16).padStart(12, "0") });
  f.tokens.push({ id: 1001, name: `${prefix}personal-token`, group: "default", status: 1 });
  f.tokens.push({ id: 1002, name: "pi-another-installation-42-000000000000", group: "default", status: 1 });
  f.createGate.resolve(); await rejectedAuth;
  const owned = f.tokens.find((token) => token.name === admittedName);
  assert.equal((await logout).revoked, true);
  assert.equal(f.secrets.has(AUTH_REF), false); assert.equal(f.stopped, 1);
  assert.equal(f.deleted.includes(owned.id), true);
  assert.equal(f.deleted.length, 106, "pagination reads finish before token deletion changes result offsets");
  assert.equal(f.deleted.includes(1001), false); assert.equal(f.deleted.includes(1002), false);
});

test("offline logout clears local credentials and account switching rejects the former provider", async () => {
  const f = fixture(); const service = f.service(); await f.login(service, true);
  const [oldProvider] = await service.listProviders();
  f.offline = true;
  assert.deepEqual(await service.logout(), { revoked: false });
  assert.equal(service.view().status, "anonymous"); assert.equal(f.secrets.has(AUTH_REF), false);
  f.offline = false; f.user = { id: 77, username: "bob", group: "team", quota: 500000 };
  f.groups = { team: { desc: "Team" } }; f.groupModels = { team: ["private-model"] };
  assert.equal((await f.login(service)).profile.id, 77);
  const providers = await service.listProviders();
  assert.equal(providers.length, 1); assert.ok(providers[0].vendorKey.startsWith("catspub:77:"));
  await assert.rejects(service.resolveAuth(oldProvider.id), { errorCode: "CATSPUB_MODEL_UNAVAILABLE" });
  assert.equal(f.secrets.has(AUTH_REF), false);
});

test("catalog failure is visible and retriable without reopening login", async () => {
  const f = fixture(); f.directoryUnavailable = true;
  const service = f.service(); const state = await f.login(service);
  assert.equal(state.status, "authenticated"); assert.equal(state.catalogError, true);
  assert.deepEqual(await service.listProviders(), []);
  f.directoryUnavailable = false;
  assert.equal((await service.refresh()).catalogError, undefined);
  assert.equal((await service.listProviders()).length, 2);
});

test("a revoked session returns to login on profile refresh", async () => {
  const f = fixture(); const service = f.service(); await f.login(service, true);
  f.selfResponse = () => Response.json({ success: false }, { status: 401 });
  assert.equal((await service.refresh()).status, "anonymous");
  assert.equal(f.secrets.has(AUTH_REF), false); assert.equal(f.stopped, 1);
});

test("isolated Passkey login receives the native MFA challenge only in main", async () => {
  const f = fixture(); f.status.passkey_login = true;
  f.loginResponse = () => ok({ require_verification: true, flow_token: "mfa-only-main", expires_at: Math.floor(f.now / 1000) + 300, methods: [{ method: "passkey", available: true }] });
  const service = f.service(); await f.login(service);
  assert.equal((await service.browserLogin("passkey", false)).status, "authenticated");
  assert.equal(f.browserInput.challenge.flow_token, "mfa-only-main");
  assert.equal(f.secrets.has(AUTH_REF), false);
});

test("API rejects origin escapes and sanitizes network and invalid auth responses", async () => {
  const api = new CatspubApi(async () => { throw new Error("sensitive-cookie-and-password"); });
  await assert.rejects(api.call("/api/../../outside"), { errorCode: "CATSPUB_INVALID_REQUEST" });
  await assert.rejects(api.call("https://other.invalid/api/status"), { errorCode: "CATSPUB_INVALID_REQUEST" });
  await assert.rejects(api.call("/api/status"), (error) => error.errorCode === "CATSPUB_NETWORK_ERROR" && !error.message.includes("sensitive"));
  assert.throws(() => api.accept({ access_token: "a", session: { sid: "s" }, user: { id: 1 } }), { errorCode: "CATSPUB_INVALID_RESPONSE" });
});

test("logout closes the execution transport before I/O and always restarts it", async () => {
  const events = []; const read = deferred();
  const state = {
    sidecar: { async dispose() { events.push("disposed"); } },
    host: { async call() { await read.promise; return { sessions: [{ id: "local-history" }] }; } },
    agentHostBridge: { queue: { list: (id) => [{ id: `queue-${id}` }], async remove(id) { events.push(id); } } },
  };
  const stop = stopCatspubWork(state, new Map([["active", "turn"]]), async () => { events.push("restarted"); },
    async (id, turn) => { events.push(`${id}:${turn}`); }, (id) => events.push(`tools-${id}`));
  assert.equal(state.sidecar, null); assert.deepEqual(events, ["disposed"]);
  read.resolve(); await stop;
  assert.equal(events.includes("active:turn"), true); assert.equal(events.includes("queue-local-history"), true);
  assert.equal(events.at(-1), "restarted");
});

test("context tiers reach the actual launch and compaction budget", async () => {
  const f = fixture(); const service = f.service(); await f.login(service);
  const providers = await service.listProviders(); const provider = providers[0];
  const host = {
    isAvailable: () => true,
    async call(method, input) {
      if (method === "commandShells.list") {
        const shell = { id: "windows-powershell", label: "PowerShell", dialect: "powershell", available: true, isDefault: true };
        return { configuredId: shell.id, effective: shell, fallback: false, choices: [shell] };
      }
      if (method === "skills.disabledBuiltins" || method === "agents.disabledBuiltins") return { disabled: [] };
      if (method === "skills.active") return { skills: [] };
      if (method === "mcp.active") return { servers: [] };
      if (method === "agents.active") return { subagents: [] };
      return f.call(method, input);
    },
  };
  const catalog = createProviderCatalogRuntime({ getHost: () => host, modelsDevCatalog: models, siteProviders: () => service.listProviders() });
  const launch = createSessionLaunchRuntime({
    catspub: service, runtimeState: { host, sidecar: { setVendorAuthBindings() {} }, agentHostBridge: null },
    logger: { app() {} }, userMcp: { setRecords() {}, async toolsForProject() { return []; } },
    plugins: { getTools: () => [], getSkills: () => [], listLoaded: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: temp, vendorOAuth: { async bindingFor() { throw new Error("unexpected vendor OAuth"); } },
    modelsDevCatalog: models, getWorkspacePath: () => null, pluginActiveInProject: () => true,
    bindingForModel: catalog.bindingForModel, effectiveSubagentModelConfig: catalog.effectiveSubagentModelConfig,
    normalizeThinkingLevel: catalog.normalizeThinkingLevel,
  });
  const resolve = (tier) => launch.resolveAgentRuntimeLaunch("context-session", { providerId: provider.id, modelId: "gpt-4o", contextWindowLimit: tier }, { defaultMode: "agent" });
  const limited = await resolve(32000);
  assert.equal(limited.sidecarParams.provider.authKind, "catspub");
  assert.equal(limited.sidecarParams.provider.apiKey, "");
  assert.equal(limited.sidecarParams.provider.modelConfig.contextWindow, 32000);
  assert.ok(contextBudgetLimitsFor(limited.sidecarParams.provider.modelConfig).hardLimit < 32000);
  const automatic = await resolve(null);
  assert.equal(automatic.sidecarParams.provider.modelConfig.contextWindow, provider.models[0].contextWindow);
  assert.equal((await resolve(1000000)).sidecarParams.provider.modelConfig.contextWindow, provider.models[0].contextWindow);
  await service.logout();
  assert.throws(() => limited.assertCurrentAccount(), { errorCode: "CATSPUB_CANCELLED" });
  assert.equal(limited.accountSignal.aborted, true);
  await assert.rejects(async () => limited.requestAuth(), { errorCode: "CATSPUB_CANCELLED" });
});
