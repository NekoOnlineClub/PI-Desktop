import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { CATSPUB_ORIGIN, type CatspubBrowserMethod } from "@pi-desktop/shared";
import type { BrowserAuthorization } from "./service";
import { siteError, type AuthBundle, type LoginChallenge } from "./api";
import { createInlineCaptcha } from "./captcha-view";

type Captured = { kind: "login"; bundle: AuthBundle };

/** Runs the site's CAPTCHA inline and WebAuthn/OAuth on their HTTPS origin. */
export function createCatspubBrowser(getParent: () => BrowserWindow | null): BrowserAuthorization {
  const captcha = createInlineCaptcha(getParent);
  async function open(signal: AbortSignal, challenge?: LoginChallenge, method?: CatspubBrowserMethod, remember = false) {
    signal.throwIfAborted();
    const isolatedSession = session.fromPartition(`catspub-auth-${randomUUID()}`, { cache: false });
    const window = new BrowserWindow({
      title: "Catspub",
      width: 560, height: 760,
      minWidth: 360, parent: getParent() ?? undefined, autoHideMenuBar: true,
      webPreferences: { session: isolatedSession, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const permitted = (url: string) => {
      try { const parsed = new URL(url); return parsed.protocol === "https:" &&
        (parsed.origin === CATSPUB_ORIGIN || parsed.hostname === "github.com"); }
      catch { return false; }
    };
    window.webContents.on("will-navigate", (event, url) => { if (!permitted(url)) event.preventDefault(); });
    window.webContents.on("will-redirect", (event, url) => { if (!permitted(url)) event.preventDefault(); });
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    return new Promise<{ captured: Captured; refreshCookie: string }>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(siteError("CATSPUB_AUTH_TIMEOUT")), 5 * 60000);
      const finish = (error?: Error, result?: { captured: Captured; refreshCookie: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (!window.isDestroyed()) {
          if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
          window.destroy();
        }
        void isolatedSession.clearStorageData().catch(() => {});
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(siteError("CATSPUB_CANCELLED"));
      const receive = async (value: Captured) => {
        if (settled) return;
        const cookies = await isolatedSession.cookies.get({ url: `${CATSPUB_ORIGIN}/api/user/auth/refresh`, name: "new_api_refresh" });
        finish(undefined, { captured: value, refreshCookie: cookies[0]?.value ?? "" });
      };
      // Observe only this isolated window's HTTPS auth responses in main. The site gets no IPC bridge.
      const responses = new Set<string>();
      try { window.webContents.debugger.attach("1.3"); }
      catch { finish(siteError("CATSPUB_BROWSER_AUTH_FAILED")); return; }
      window.webContents.debugger.on("message", (_event, method, params) => {
        if (method === "Network.responseReceived") {
          const url = new URL(params.response.url);
          if (url.origin !== CATSPUB_ORIGIN || params.response.status !== 200) return;
          if (/^\/api\/(user\/(login(\/verify|\/passkey\/finish)?|passkey\/login\/finish|auth\/refresh)|oauth\/github)$/.test(url.pathname)) {
            responses.add(params.requestId);
          }
        } else if (method === "Network.loadingFinished" && responses.delete(params.requestId)) {
          void window.webContents.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId }).then(async (body) => {
            const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
            if (text.length > 65536) return;
            const result = JSON.parse(text);
            if (result?.success === true && result.data?.access_token && result.data?.session?.sid && result.data?.user?.id) {
              await receive({ kind: "login", bundle: result.data });
            }
          }).catch(() => {});
        } else if (method === "Network.loadingFailed") responses.delete(params.requestId);
      });
      signal.addEventListener("abort", abort, { once: true });
      window.on("closed", () => finish(siteError("CATSPUB_CANCELLED")));
      if (signal.aborted) { abort(); return; }
      void (async () => {
        // Navigation creates the renderer target needed by the debugger domains.
        await window.loadURL(`${CATSPUB_ORIGIN}/sign-in`);
        await window.webContents.debugger.sendCommand("Network.enable");
        if (method === "passkey") {
          // Browser-native JSON conversion preserves WebAuthn's RP/origin checks.
          await window.webContents.executeJavaScript(`(async () => {
            const post = async (path, body) => {
              const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
              const result = await response.json(); if (!response.ok || !result.success) throw new Error('verification failed');
              return result.data;
            };
            const flow = ${JSON.stringify(challenge?.flow_token ?? null)};
            const base = flow ? '/api/user/login/passkey' : '/api/user/passkey/login';
            const begin = await post(base + '/begin', flow ? {flow_token:flow} : {remember_login:${JSON.stringify(remember)}});
            const options = begin.options ?? begin;
            const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey ?? options);
            const credential = await navigator.credentials.get({publicKey});
            await post(base + '/finish', flow ? {flow_token:flow,passkey_flow_token:begin.flow_token,credential:credential.toJSON()}
              : {flow_token:begin.flow_token,credential:credential.toJSON()});
          })()`, true);
        } else if (method === "github") {
          await window.webContents.executeJavaScript(`(async () => {
            const response = await fetch('/api/oauth/state', {method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({provider:'github',intent:'login',remember_login:${JSON.stringify(remember)}})});
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error('authorization failed');
            if (result.data?.authorization_url) { location.assign(result.data.authorization_url); return; }
            const status = await (await fetch('/api/status')).json();
            const url = new URL('https://github.com/login/oauth/authorize');
            url.search = new URLSearchParams({client_id:status.data.github_client_id,state:result.data,scope:'user:email'}).toString();
            location.assign(url.href);
          })()`);
        }
      })().catch(() => finish(siteError("CATSPUB_BROWSER_AUTH_FAILED")));
    });
  }
  return {
    captcha: captcha.open,
    updateCaptcha: captcha.update,
    async login(method, remember, signal, challenge) {
      const result = await open(signal, challenge, method, remember);
      if (result.captured.kind !== "login") throw siteError("CATSPUB_INVALID_RESPONSE");
      return { bundle: result.captured.bundle, refreshCookie: result.refreshCookie };
    },
  };
}
