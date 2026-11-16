import { createHash } from "node:crypto";
import {
  CATSPUB_AUTH_KIND, CATSPUB_ORIGIN,
  type CatspubBrowserMethod, type CatspubLoginInput, type CatspubProfile,
  type CatspubCaptchaRequest,
  type CatspubState, type ProviderPublic, type ModelBinding,
} from "@pi-desktop/shared";
import { createInstallationIdentity } from "../installation-identity";
import { capabilitiesFromModelConfig, modelConfigWithBinding } from "@pi-desktop/agent-runtime";
import type { ModelsDevCatalog } from "../models-dev-catalog";
import { catalogModelConfigFor } from "../models-dev-catalog";
import { CatspubApi, encryptSitePassword, siteError, type AuthBundle, type HostCall, type LoginChallenge, type SiteStatus, type SiteUser } from "./api";

const AUTH_REF = "secret:catspub:remembered-session";
type Pricing = { model_name: string; enable_groups?: string[]; supported_endpoint_types?: string[] };
type RelayToken = { id: number; name: string; group: string; status: number };
type Active = { api: CatspubApi; user: SiteUser; expiresAt: number; remember: boolean };
export type BrowserAuthorization = {
  captcha(status: SiteStatus, signal: AbortSignal, request: CatspubCaptchaRequest): Promise<string>;
  updateCaptcha(request: CatspubCaptchaRequest): void;
  login(method: CatspubBrowserMethod, remember: boolean, signal: AbortSignal, challenge?: LoginChallenge): Promise<{ bundle: AuthBundle; refreshCookie: string }>;
};
export type CatspubServiceDependencies = {
  call: HostCall;
  models: ModelsDevCatalog;
  browser: BrowserAuthorization;
  stopWork: () => Promise<void>;
  request?: typeof fetch;
  now?: () => number;
};

export class CatspubService {
  private active?: Active;
  private pending?: { api: CatspubApi; challenge?: LoginChallenge; remember: boolean };
  private captcha?: { id: string; controller: AbortController; token?: string; expiresAt: number };
  private status: SiteStatus = {};
  private providers: ProviderPublic[] = [];
  private updatedAt = 0;
  private epoch = 0;
  private restored = false;
  private restoreTask?: Promise<void>;
  private refreshTask?: Promise<void>;
  private catalogTask?: Promise<void>;
  private catalogError = false;
  private logoutTask?: Promise<{ revoked: boolean }>;
  private credentialWrites: Promise<unknown> = Promise.resolve();
  private readonly tokens = new Map<string, Promise<string>>();
  private readonly relayTasks = new Set<Promise<string>>();
  private readonly installationId: () => Promise<string>;
  private readonly now: () => number;

  constructor(private readonly deps: CatspubServiceDependencies) {
    this.installationId = createInstallationIdentity(deps.call);
    this.now = deps.now ?? Date.now;
  }

  private api() { return new CatspubApi(this.deps.request); }
  private assertEpoch(epoch: number) { if (epoch !== this.epoch) throw siteError("CATSPUB_CANCELLED"); }
  private requireAccount(): Active {
    if (!this.active) throw siteError("CATSPUB_SESSION_EXPIRED");
    return this.active;
  }
  isAuthenticated() { return Boolean(this.active); }
  generation() { return this.epoch; }
  assertGeneration(epoch: number) { this.assertEpoch(epoch); this.requireAccount(); }
  accountSignal() { return this.requireAccount().api.controller.signal; }

  private profile(): CatspubProfile | undefined {
    const user = this.active?.user;
    if (!user) return undefined;
    const currency = this.status.quota_display_type ?? "USD";
    const units = this.status.quota_per_unit && this.status.quota_per_unit > 0 ? this.status.quota_per_unit : 500000;
    const rate = currency === "CNY" ? (this.status.usd_exchange_rate ?? 1)
      : currency === "CUSTOM" ? (this.status.custom_currency_exchange_rate ?? 1) : 1;
    return { id: user.id, username: user.username, displayName: user.display_name || user.username,
      group: user.group, currency: currency === "CUSTOM" ? (this.status.custom_currency_symbol ?? "") : currency,
      balance: currency === "TOKENS" ? user.quota : user.quota / units * rate };
  }

  view(): CatspubState {
    return {
      status: this.active ? "authenticated" : this.pending?.challenge ? "verification" : "anonymous",
      options: { password: this.status.password_login_enabled !== false, github: this.status.github_oauth === true,
        passkey: this.status.passkey_login === true, captcha: this.status.captcha_enabled === true },
      profile: this.profile(),
      ...(this.pending?.challenge ? { challenge: { expiresAt: this.pending.challenge.expires_at,
        methods: this.pending.challenge.methods.map(({ method, available }) => ({ method, available })) } } : {}),
      ...(this.updatedAt ? { catalogUpdatedAt: new Date(this.updatedAt).toISOString() } : {}),
      ...(this.catalogError ? { catalogError: true } : {}),
    };
  }

  async initialize(): Promise<CatspubState> {
    if (!this.restored) {
      this.restoreTask ??= this.restore().finally(() => { this.restoreTask = undefined; });
      await this.restoreTask;
    }
    if (this.active) {
      try { await this.authenticated(); }
      catch (error) {
        if (this.active) throw error;
      }
    }
    return this.view();
  }

  private async restore() {
    const epoch = this.epoch;
    this.status = await this.api().call<SiteStatus>("/api/status");
    this.assertEpoch(epoch);
    const saved = await this.deps.call<{ value?: string }>("secrets.getForRuntime", { secretRef: AUTH_REF });
    this.assertEpoch(epoch);
    if (saved.value) {
      try {
        const stored = JSON.parse(saved.value) as { refreshCookie: string; sid: string };
        if (!stored.refreshCookie || !stored.sid) throw siteError("CATSPUB_INVALID_RESPONSE");
        const api = this.api();
        api.refreshCookie = stored.refreshCookie;
        api.sid = stored.sid;
        const bundle = await api.call<AuthBundle>("/api/user/auth/refresh", {});
        this.assertEpoch(epoch);
        await this.accept(api, bundle, true, epoch);
      } catch (error) {
        this.assertEpoch(epoch);
        if ((error as { errorCode?: string }).errorCode === "CATSPUB_NETWORK_ERROR") throw error;
        const clear = this.credentialWrites.catch(() => {}).then(() => {
          this.assertEpoch(epoch);
          return this.deps.call("secrets.delete", { secretRef: AUTH_REF });
        });
        this.credentialWrites = clear;
        await clear;
      }
    }
    this.restored = true;
  }

  async login(input: CatspubLoginInput): Promise<CatspubState> {
    await this.logoutTask;
    if (this.active) throw siteError("CATSPUB_ALREADY_AUTHENTICATED");
    if (!input || typeof input.username !== "string" || typeof input.password !== "string" ||
        !input.username.trim() || !input.password || input.username.length > 256 || input.password.length > 8192 || typeof input.rememberLogin !== "boolean") {
      throw siteError("CATSPUB_INVALID_REQUEST");
    }
    const captcha = this.captcha && this.captcha.id === input.captchaId && this.captcha.expiresAt > this.now() ? this.captcha.token : undefined;
    this.cancel();
    const epoch = this.epoch;
    const api = this.api();
    this.pending = { api, remember: input.rememberLogin };
    this.status = await api.call<SiteStatus>("/api/status");
    this.assertEpoch(epoch);
    if (this.status.captcha_enabled && !captcha) throw siteError("CATSPUB_CAPTCHA_REQUIRED");
    if (this.status.password_login_enabled === false) throw siteError("CATSPUB_ACCESS_DENIED");
    const fields = this.status.password_login_encryption_enabled
      ? encryptSitePassword(input.password, await api.call<{ kid: string; public_key: string }>("/api/user/login/encryption-key"))
      : { password: input.password };
    const result = await api.call<AuthBundle | LoginChallenge>("/api/user/login", {
      username: input.username.trim(), remember_login: input.rememberLogin, ...fields,
    }, { captcha });
    this.assertEpoch(epoch);
    return this.finishLogin(api, result, input.rememberLogin, epoch);
  }

  private async finishLogin(api: CatspubApi, result: AuthBundle | LoginChallenge, remember: boolean, epoch: number) {
    if ("require_verification" in result && result.require_verification) {
      this.pending = { api, remember, challenge: result };
      return this.view();
    }
    await this.accept(api, result as AuthBundle, remember, epoch);
    return this.view();
  }

  async verify(code: string): Promise<CatspubState> {
    const pending = this.pending;
    if (!pending?.challenge || typeof code !== "string" || !/^[0-9A-Za-z-]{6,32}$/.test(code)) throw siteError("CATSPUB_INVALID_CODE");
    const epoch = this.epoch;
    const result = await pending.api.call<AuthBundle>("/api/user/login/verify", {
      flow_token: pending.challenge.flow_token, method: "2fa", code,
    });
    this.assertEpoch(epoch);
    await this.accept(pending.api, result, pending.remember, epoch);
    return this.view();
  }

  async browserLogin(method: CatspubBrowserMethod, remember: boolean): Promise<CatspubState> {
    await this.logoutTask;
    if (method !== "github" && method !== "passkey") throw siteError("CATSPUB_INVALID_REQUEST");
    if (this.active) throw siteError("CATSPUB_ALREADY_AUTHENTICATED");
    const challenge = method === "passkey" ? this.pending?.challenge : undefined;
    if (!challenge) this.cancel();
    const epoch = this.epoch;
    const api = this.pending?.api ?? this.api();
    this.pending ??= { api, remember };
    const result = await this.deps.browser.login(method, remember, api.controller.signal, challenge);
    this.assertEpoch(epoch);
    api.refreshCookie = result.refreshCookie;
    await this.accept(api, result.bundle, remember, epoch);
    return this.view();
  }

  cancel(): CatspubState {
    if (!this.active) ++this.epoch;
    this.pending?.api.controller.abort();
    this.pending = undefined;
    this.cancelCaptcha();
    return this.view();
  }

  async startCaptcha(request: CatspubCaptchaRequest): Promise<{ ready: true }> {
    await this.logoutTask;
    if (!request || typeof request.id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(request.id) ||
        this.active || this.pending || !this.status.captcha_enabled) throw siteError("CATSPUB_INVALID_REQUEST");
    this.cancelCaptcha();
    const epoch = this.epoch;
    const attempt = { id: request.id, controller: new AbortController(), expiresAt: 0, token: undefined as string | undefined };
    this.captcha = attempt;
    try {
      const token = await this.deps.browser.captcha(this.status, attempt.controller.signal, request);
      this.assertEpoch(epoch);
      if (this.captcha !== attempt || attempt.controller.signal.aborted || !token) throw siteError("CATSPUB_CANCELLED");
      attempt.token = token;
      attempt.expiresAt = this.now() + 240000;
      return { ready: true };
    } catch (error) {
      if (this.captcha === attempt) this.captcha = undefined;
      throw error;
    }
  }

  updateCaptcha(request: CatspubCaptchaRequest): void {
    if (this.captcha && request?.id === this.captcha.id && !this.captcha.token) this.deps.browser.updateCaptcha(request);
  }

  cancelCaptcha(id?: string): void {
    if (id !== undefined && id !== this.captcha?.id) return;
    this.captcha?.controller.abort();
    this.captcha = undefined;
  }

  private async persist(account: Active, epoch: number) {
    const write = this.credentialWrites.catch(() => {}).then(async () => {
      this.assertEpoch(epoch);
      if (account.remember && account.api.refreshCookie) {
        await this.deps.call("secrets.set", { secretRef: AUTH_REF,
          value: JSON.stringify({ refreshCookie: account.api.refreshCookie, sid: account.api.sid }) });
      } else await this.deps.call("secrets.delete", { secretRef: AUTH_REF });
    });
    this.credentialWrites = write;
    await write;
  }

  private async accept(api: CatspubApi, bundle: AuthBundle, remember: boolean, epoch: number) {
    this.assertEpoch(epoch);
    api.accept(bundle);
    const account = { api, user: bundle.user, expiresAt: bundle.access_expires_at, remember };
    await this.persist(account, epoch);
    this.assertEpoch(epoch);
    this.active = account;
    this.restored = true;
    this.pending = undefined;
    this.providers = [];
    this.updatedAt = 0;
    this.catalogError = false;
    this.tokens.clear();
    // A directory failure is retriable from the profile, without losing a successful login.
    try { await this.refreshDirectory(); }
    catch { this.assertEpoch(epoch); this.catalogError = true; }
  }

  private async authenticated(): Promise<Active> {
    const account = this.requireAccount();
    if (account.expiresAt * 1000 > this.now() + 60000) return account;
    if (!this.refreshTask) {
      const epoch = this.epoch;
      const task = (async () => {
        const bundle = await account.api.call<AuthBundle>("/api/user/auth/refresh", {});
        this.assertEpoch(epoch);
        if (bundle.user?.id !== account.user.id) throw siteError("CATSPUB_SESSION_EXPIRED");
        account.api.accept(bundle);
        account.user = bundle.user;
        account.expiresAt = bundle.access_expires_at;
        await this.persist(account, epoch);
        this.assertEpoch(epoch);
      })().catch(async (error) => {
        if ((error as { errorCode?: string }).errorCode === "CATSPUB_SESSION_EXPIRED" && epoch === this.epoch) await this.logout();
        throw error;
      }).finally(() => { if (this.refreshTask === task) this.refreshTask = undefined; });
      this.refreshTask = task;
    }
    await this.refreshTask;
    if (account !== this.active) throw siteError("CATSPUB_CANCELLED");
    return account;
  }

  async refresh(): Promise<CatspubState> {
    const epoch = this.epoch;
    try {
      const account = await this.authenticated();
      const [status, user] = await Promise.all([
        account.api.call<SiteStatus>("/api/status"), account.api.call<SiteUser>("/api/user/self"),
      ]);
      this.assertEpoch(epoch);
      if (user.id !== account.user.id) throw siteError("CATSPUB_SESSION_EXPIRED");
      this.status = status;
      account.user = user;
      await this.refreshDirectory();
    } catch (error) {
      if ((error as { errorCode?: string }).errorCode !== "CATSPUB_SESSION_EXPIRED") throw error;
      if (epoch === this.epoch) await this.logout();
    }
    return this.view();
  }

  private async refreshDirectory(): Promise<void> {
    if (this.catalogTask) return this.catalogTask;
    const epoch = this.epoch;
    const task = (async () => {
      const account = await this.authenticated();
      const [groups, pricing, existing] = await Promise.all([
        account.api.call<Record<string, { desc?: string; ratio?: number }>>("/api/user/self/groups"),
        account.api.call<Pricing[]>("/api/pricing"),
        this.deps.call<{ providers: ProviderPublic[] }>("providers.list", { includeDisabled: true }),
        this.deps.models.ensureLoaded(),
      ]);
      this.assertEpoch(epoch);
      const directory = await Promise.all(Object.entries(groups).map(async ([group, info]) => ({
        group, name: info.desc ? `${group} · ${info.desc}` : group,
        ids: await account.api.call<string[]>(`/api/user/models?group=${encodeURIComponent(group)}`),
      })));
      this.assertEpoch(epoch);
      const next: ProviderPublic[] = [];
      for (const { group, name, ids } of directory) {
        const vendorKey = `catspub:${account.user.id}:${encodeURIComponent(group)}`;
        const models: ModelBinding[] = [...new Set(ids)].flatMap((id) => {
          const endpoints = pricing.find((row) => row.model_name === id)?.supported_endpoint_types ?? ["openai"];
          const apiStyle = endpoints.includes("anthropic") ? "anthropic_messages"
            : endpoints.includes("openai-response") ? "responses" : endpoints.includes("openai") ? "chat_completions" : undefined;
          if (!apiStyle) return [];
          const config = catalogModelConfigFor(this.deps.models, { vendorKey: "custom", modelId: id, baseUrl: CATSPUB_ORIGIN, apiStyle });
          return [{ id, contextWindow: config.contextWindow || 128000, contextWindowSource: "user" as const,
            maxTokens: config.maxTokens || 8192, maxTokensSource: "user" as const,
            thinkingLevels: config.supportedThinkingLevels ? [...config.supportedThinkingLevels] : ["off" as const],
            defaultThinkingLevel: null, availableForSubagents: true,
            contextWindowEstimated: config.source === "generic", apiStyle }];
        });
        const previous = existing.providers.find((p) => p.authKind === CATSPUB_AUTH_KIND && p.vendorKey === vendorKey);
        this.assertEpoch(epoch);
        const input = { name, vendorKey, baseUrl: `${CATSPUB_ORIGIN}/v1`, authKind: CATSPUB_AUTH_KIND,
          type: "openai_compatible", protocol: "openai", apiStyle: "chat_completions", models };
        const saved = previous
          ? await this.deps.call<{ provider: ProviderPublic }>("providers.update", { id: previous.id, ...input, enabled: true })
          : await this.deps.call<{ provider: ProviderPublic }>("providers.create", input);
        this.assertEpoch(epoch);
        // Readiness is granted by this account's directory, not by a persisted API key flag.
        next.push({ ...saved.provider, models, hasSecret: true });
      }
      this.providers = next;
      this.updatedAt = this.now();
      this.catalogError = false;
    })();
    this.catalogTask = task;
    try { await task; }
    catch (error) {
      if (epoch === this.epoch) this.catalogError = true;
      throw error;
    } finally { if (this.catalogTask === task) this.catalogTask = undefined; }
  }

  async listProviders(): Promise<ProviderPublic[]> {
    if (!this.active) return [];
    const epoch = this.epoch;
    try {
      await this.authenticated();
      if (!this.updatedAt || this.now() - this.updatedAt > 120000) await this.refreshDirectory();
    } catch (error) {
      if (epoch !== this.epoch) return [];
      if ((error as { errorCode?: string }).errorCode === "CATSPUB_SESSION_EXPIRED") await this.logout();
      else { this.providers = []; this.catalogError = true; }
      return [];
    }
    this.assertEpoch(epoch);
    return this.providers;
  }

  async bindingFor(providerId: string, modelId: string) {
    const providers = await this.listProviders();
    const provider = providers.find((p) => p.id === providerId);
    const binding = provider?.models.find((m) => m.id === modelId);
    if (!provider || !binding) throw siteError("CATSPUB_MODEL_UNAVAILABLE");
    const modelConfig = modelConfigWithBinding(catalogModelConfigFor(this.deps.models, {
      vendorKey: "custom", modelId, baseUrl: CATSPUB_ORIGIN, apiStyle: binding.apiStyle,
    }), binding);
    return { baseUrl: `${CATSPUB_ORIGIN}/v1`, apiStyle: binding.apiStyle ?? "chat_completions", modelConfig,
      ...capabilitiesFromModelConfig(modelConfig) };
  }

  async resolveAuth(providerId: string): Promise<{ apiKey: string }> {
    const epoch = this.epoch;
    const account = await this.authenticated();
    const provider = (await this.listProviders()).find((p) => p.id === providerId);
    if (!provider) throw siteError("CATSPUB_MODEL_UNAVAILABLE");
    const group = decodeURIComponent(provider.vendorKey.slice(`catspub:${account.user.id}:`.length));
    let token = this.tokens.get(group);
    if (!token) {
      token = this.relayKey(account, group, epoch).catch((error) => {
        if (this.tokens.get(group) === token) this.tokens.delete(group);
        throw error;
      });
      this.tokens.set(group, token);
      this.relayTasks.add(token);
      void token.finally(() => this.relayTasks.delete(token!)).catch(() => {});
    }
    const apiKey = await token;
    this.assertEpoch(epoch);
    return { apiKey };
  }

  private async tokenPrefix(userId: number) { return `pi-${(await this.installationId()).replaceAll("-", "").slice(0, 16)}-${userId}-`; }

  private async relayKey(account: Active, group: string, epoch: number): Promise<string> {
    // Let an admitted server-side creation settle before logout searches and revokes it.
    const api = account.api.snapshot();
    const name = `${await this.tokenPrefix(account.user.id)}${createHash("sha256").update(group).digest("hex").slice(0, 12)}`;
    this.assertEpoch(epoch);
    const find = async () => {
      const result = await api.call<{ items: RelayToken[] }>(`/api/token/search?keyword=${encodeURIComponent(name)}&p=1&page_size=100`);
      return result.items?.find((t) => t.name === name && t.group === group && t.status === 1);
    };
    let token = await find();
    this.assertEpoch(epoch);
    if (!token) {
      await api.call("/api/token/", { name, group, unlimited_quota: true, expired_time: -1, remain_quota: 0, model_limits_enabled: false });
      this.assertEpoch(epoch);
      token = await find();
    }
    this.assertEpoch(epoch);
    if (!token) throw siteError("CATSPUB_RELAY_TOKEN_FAILED");
    const result = await api.call<{ key: string }>(`/api/token/${token.id}/key`, {});
    this.assertEpoch(epoch);
    if (!result.key) throw siteError("CATSPUB_RELAY_TOKEN_FAILED");
    return result.key;
  }

  logout(): Promise<{ revoked: boolean }> {
    if (this.logoutTask) return this.logoutTask;
    const task = this.performLogout().finally(() => { if (this.logoutTask === task) this.logoutTask = undefined; });
    this.logoutTask = task;
    return task;
  }

  private async performLogout(): Promise<{ revoked: boolean }> {
    const old = this.active;
    const cleanup = old?.api.snapshot();
    ++this.epoch;
    this.active = undefined;
    this.pending?.api.controller.abort();
    this.pending = undefined;
    this.cancelCaptcha();
    this.providers = [];
    this.tokens.clear();
    this.updatedAt = 0;
    this.catalogError = false;
    this.catalogTask = undefined;
    this.refreshTask = undefined;
    old?.api.controller.abort();
    let revoked = true;
    const clear = this.credentialWrites.catch(() => {}).then(() => this.deps.call("secrets.delete", { secretRef: AUTH_REF }));
    this.credentialWrites = clear;
    const local = await Promise.allSettled([clear, this.deps.stopWork(), ...this.relayTasks]);
    if (local.slice(0, 2).some((result) => result.status === "rejected")) revoked = false;
    if (!old || !cleanup) return { revoked };
    try {
      const prefix = await this.tokenPrefix(old.user.id);
      const ownedIds: number[] = [];
      for (let page = 1; page < 100; page++) {
        const result = await cleanup.call<{ items: RelayToken[] }>(`/api/token/search?keyword=${encodeURIComponent(prefix)}&p=${page}&page_size=100`);
        const own = result.items.filter((t) => t.name.startsWith(prefix) && /^[0-9a-f]{12}$/.test(t.name.slice(prefix.length)));
        ownedIds.push(...own.map((token) => token.id));
        if (result.items.length < 100) break;
      }
      for (const id of ownedIds) await cleanup.call(`/api/token/${id}`, undefined, { method: "DELETE" });
    } catch { revoked = false; }
    try { await cleanup.call("/api/user/auth/logout", {}); } catch { revoked = false; }
    return { revoked };
  }
}
