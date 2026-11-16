import { randomUUID } from "node:crypto";
import { WebContentsView, session, type BrowserWindow } from "electron";
import { CATSPUB_ORIGIN, type CatspubCaptchaRequest } from "@pi-desktop/shared";
import { scaleBoundsToDip } from "../plugin-view-bounds";
import { siteError, type SiteStatus } from "./api";

/** An unprivileged site view placed inside the renderer's CAPTCHA field. */
export function createInlineCaptcha(getParent: () => BrowserWindow | null) {
  let active: { id: string; update: (request: CatspubCaptchaRequest) => void } | undefined;

  function validate(request: CatspubCaptchaRequest) {
    const bounds = request?.bounds;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
        Math.abs(bounds.x) > 100000 || Math.abs(bounds.y) > 100000 ||
        bounds.width < 64 || bounds.width > 1024 || bounds.height < 32 || bounds.height > 256 ||
        (request.theme !== "light" && request.theme !== "dark")) throw siteError("CATSPUB_INVALID_REQUEST");
  }

  return {
    update(request: CatspubCaptchaRequest) {
      validate(request);
      if (active?.id === request.id) active.update(request);
    },
    async open(status: SiteStatus, signal: AbortSignal, request: CatspubCaptchaRequest): Promise<string> {
      validate(request);
      signal.throwIfAborted();
      const parent = getParent();
      if (!parent || parent.isDestroyed()) throw siteError("CATSPUB_CANCELLED");
      const ownerContents = parent.webContents;
      if (!status.captcha_provider?.startsWith("cap")) throw siteError("CATSPUB_CAPTCHA_UNSUPPORTED");
      const config = status.captcha_public_config ?? {};
      let endpoint: URL;
      try { endpoint = new URL(config.endpoint ?? ""); }
      catch { throw siteError("CATSPUB_INVALID_RESPONSE"); }
      if (endpoint.protocol !== "https:") throw siteError("CATSPUB_INVALID_RESPONSE");

      const isolated = session.fromPartition(`catspub-captcha-${randomUUID()}`, { cache: false });
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const view = new WebContentsView({ webPreferences: { session: isolated, sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
      const contents = view.webContents;
      const background = request.theme === "dark" ? "#181818" : "#ffffff";
      view.setBackgroundColor(background);
      view.setVisible(false);
      parent.contentView.addChildView(view);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      const permitted = (url: string) => URL.canParse(url) && new URL(url).origin === CATSPUB_ORIGIN;
      contents.on("will-navigate", (event, url) => { if (!permitted(url)) event.preventDefault(); });
      contents.on("will-redirect", (event, url) => { if (!permitted(url)) event.preventDefault(); });

      return new Promise<string>((resolve, reject) => {
        let settled = false;
        let loaded = false;
        let presentation = request;
        const update = (next: CatspubCaptchaRequest) => {
          presentation = next;
          if (settled || parent.isDestroyed()) return;
          const zoom = ownerContents.getZoomFactor();
          const raw = next.bounds;
          const [width, height] = parent.getContentSize();
          const visible = loaded && raw.x >= 0 && raw.y >= 0 &&
            (raw.x + raw.width) * zoom <= width + 1 && (raw.y + raw.height) * zoom <= height + 1;
          view.setBounds(scaleBoundsToDip(raw, zoom));
          contents.setZoomFactor(zoom);
          view.setVisible(visible);
        };
        const entry = { id: request.id, update };
        active = entry;
        const timeout = setTimeout(() => finish(siteError("CATSPUB_AUTH_TIMEOUT")), 300000);
        const finish = (error?: Error, token?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          parent.removeListener("closed", closed);
          ownerContents.removeListener("did-start-navigation", navigation);
          if (active === entry) active = undefined;
          if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
          if (!contents.isDestroyed()) {
            if (contents.debugger.isAttached()) contents.debugger.detach();
            contents.close({ waitForBeforeUnload: false });
          }
          void isolated.clearStorageData().catch(() => {});
          if (error) reject(error); else resolve(token!);
        };
        const abort = () => finish(siteError("CATSPUB_CANCELLED"));
        const closed = () => finish(siteError("CATSPUB_CANCELLED"));
        const navigation = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean) => {
          if (mainFrame) finish(siteError("CATSPUB_CANCELLED"));
        };
        signal.addEventListener("abort", abort, { once: true });
        parent.once("closed", closed);
        ownerContents.on("did-start-navigation", navigation);
        contents.on("render-process-gone", () => finish(siteError("CATSPUB_BROWSER_AUTH_FAILED")));
        contents.debugger.on("message", (_event, method, params) => {
          if (method === "Runtime.bindingCalled" && params.name === "catspubCaptchaSolved" && permitted(contents.getURL()) &&
              typeof params.payload === "string" && params.payload.length > 0 && params.payload.length <= 16384) finish(undefined, params.payload);
        });
        if (signal.aborted) { abort(); return; }
        void (async () => {
          await contents.loadURL(`${CATSPUB_ORIGIN}/sign-in`);
          signal.throwIfAborted();
          contents.debugger.attach("1.3");
          await contents.debugger.sendCommand("Runtime.addBinding", { name: "catspubCaptchaSolved" });
          await contents.executeJavaScript(`(async () => {
            await customElements.whenDefined('cap-widget');
            document.documentElement.style.colorScheme = ${JSON.stringify(request.theme)};
            document.documentElement.dataset.theme = ${JSON.stringify(request.theme)};
            const surface = document.createElement('div');
            Object.assign(surface.style, {position:'fixed',inset:'0',zIndex:'2147483647',display:'grid',placeItems:'center',background:${JSON.stringify(background)}});
            const widget = document.createElement('cap-widget');
            widget.setAttribute('data-cap-api-endpoint', ${JSON.stringify(`${endpoint.href.replace(/\/$/, "")}/${config.site_key ?? status.turnstile_site_key ?? ""}`)});
            widget.addEventListener('solve', event => {
              if (event.detail?.token) window.catspubCaptchaSolved(event.detail.token);
            });
            surface.append(widget); document.body.replaceChildren(surface);
          })()`);
          loaded = true;
          update(presentation);
        })().catch(() => finish(siteError("CATSPUB_BROWSER_AUTH_FAILED")));
      });
    },
  };
}
