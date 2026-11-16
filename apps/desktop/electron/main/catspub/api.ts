import { constants, createCipheriv, publicEncrypt, randomBytes } from "node:crypto";
import { CATSPUB_ORIGIN } from "@pi-desktop/shared";

export type SiteStatus = {
  password_login_enabled?: boolean;
  github_oauth?: boolean;
  passkey_login?: boolean;
  captcha_enabled?: boolean;
  captcha_provider?: string;
  captcha_public_config?: Record<string, string>;
  turnstile_site_key?: string;
  password_login_encryption_enabled?: boolean;
  quota_per_unit?: number;
  quota_display_type?: string;
  usd_exchange_rate?: number;
  custom_currency_symbol?: string;
  custom_currency_exchange_rate?: number;
};

export type SiteUser = { id: number; username: string; display_name?: string; group: string; quota: number };
export type AuthBundle = {
  access_token: string;
  access_expires_at: number;
  session: { sid: string };
  user: SiteUser;
};
export type LoginChallenge = {
  require_verification: true;
  flow_token: string;
  expires_at: number;
  methods: Array<{ method: string; available: boolean; reason?: string }>;
};
export type HostCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export function siteError(code: string): Error & { errorCode: string } {
  return Object.assign(new Error(code), { errorCode: code });
}

/** A private cookie jar per login attempt/account; never uses Electron's default session. */
export class CatspubApi {
  accessToken = "";
  refreshCookie = "";
  sid = "";
  readonly controller = new AbortController();

  constructor(private readonly request: typeof fetch = fetch) {}

  async call<T>(path: string, body?: unknown, options: { method?: string; captcha?: string } = {}): Promise<T> {
    const url = new URL(path, CATSPUB_ORIGIN);
    if (url.origin !== CATSPUB_ORIGIN || !url.pathname.startsWith("/api/") || !path.startsWith("/api/")) {
      throw siteError("CATSPUB_INVALID_REQUEST");
    }
    const headers = new Headers({ Accept: "application/json", Origin: CATSPUB_ORIGIN });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (this.sid) headers.set("X-Auth-Session", this.sid);
    if (this.refreshCookie && path.startsWith("/api/user/auth/")) headers.set("Cookie", `new_api_refresh=${this.refreshCookie}`);
    if (options.captcha) headers.set("X-Captcha-Token", options.captcha);
    let response: Response;
    try {
      response = await this.request(`${CATSPUB_ORIGIN}${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", cache: "no-store",
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)]),
      });
    } catch {
      throw siteError(this.controller.signal.aborted ? "CATSPUB_CANCELLED" : "CATSPUB_NETWORK_ERROR");
    }
    for (const cookie of response.headers.getSetCookie()) {
      const match = /^new_api_refresh=([^;]*)/.exec(cookie);
      if (match) this.refreshCookie = match[1];
    }
    let result: { success?: boolean; data?: T };
    try { result = await response.json() as typeof result; }
    catch { throw siteError(this.controller.signal.aborted ? "CATSPUB_CANCELLED" : "CATSPUB_INVALID_RESPONSE"); }
    if (!response.ok || result?.success !== true) {
      throw siteError(response.status === 401 ? "CATSPUB_SESSION_EXPIRED"
        : response.status === 429 ? "CATSPUB_RATE_LIMITED"
        : response.status === 403 ? "CATSPUB_ACCESS_DENIED" : "CATSPUB_REQUEST_FAILED");
    }
    return result.data as T;
  }

  accept(bundle: AuthBundle): void {
    if (typeof bundle?.access_token !== "string" || !bundle.access_token ||
        typeof bundle.session?.sid !== "string" || !bundle.session.sid ||
        !Number.isSafeInteger(bundle.user?.id) || bundle.user.id <= 0 ||
        typeof bundle.user.username !== "string" || !Number.isFinite(bundle.user.quota) ||
        !Number.isFinite(bundle.access_expires_at) || bundle.access_expires_at <= 0) {
      throw siteError("CATSPUB_INVALID_RESPONSE");
    }
    this.accessToken = bundle.access_token;
    this.sid = bundle.session.sid;
  }

  snapshot(): CatspubApi {
    const copy = new CatspubApi(this.request);
    copy.accessToken = this.accessToken;
    copy.refreshCookie = this.refreshCookie;
    copy.sid = this.sid;
    return copy;
  }
}

export function encryptSitePassword(password: string, key: { kid: string; public_key: string }) {
  const plaintext = Buffer.from(password, "utf8");
  const encrypt = (data: Buffer, label?: string) => publicEncrypt({
    key: key.public_key, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256", ...(label ? { oaepLabel: Buffer.from(label) } : {}),
  }, data);
  let encrypted: string;
  try { encrypted = encrypt(plaintext).toString("base64"); }
  catch {
    const secret = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secret, nonce);
    cipher.setAAD(Buffer.from(`password-v2:${key.kid}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    encrypted = ["v2", encrypt(secret, "password-v2").toString("base64"), nonce.toString("base64"), ciphertext.toString("base64")].join(".");
  }
  return { password_encrypted: encrypted, encryption_key_id: key.kid };
}
