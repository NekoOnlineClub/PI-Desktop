import { IPC, type CatspubBrowserMethod, type CatspubLoginInput, type CatspubCaptchaRequest } from "@pi-desktop/shared";
import type { IpcRegistrar } from "../ipc/types";
import type { CatspubService } from "./service";

export function registerCatspubIpc(registrar: IpcRegistrar, service: CatspubService) {
  const handle = (channel: string, fn: (...args: any[]) => Promise<unknown> | unknown) => {
    registrar.handleWithEvent(channel, async (event, ...args) => {
      registrar.assertMainWindowSender(event);
      return fn(...args);
    });
  };
  handle(IPC.invoke.catspubState, () => service.initialize());
  handle(IPC.invoke.catspubLogin, (input: CatspubLoginInput) => service.login(input));
  handle(IPC.invoke.catspubVerify, (code: string) => service.verify(code));
  handle(IPC.invoke.catspubBrowserLogin, (input: { method: CatspubBrowserMethod; rememberLogin: boolean }) => {
    if (!input || typeof input.rememberLogin !== "boolean") throw new Error("CATSPUB_INVALID_REQUEST");
    return service.browserLogin(input.method, input.rememberLogin);
  });
  handle(IPC.invoke.catspubCancel, () => service.cancel());
  handle(IPC.invoke.catspubRefresh, () => service.refresh());
  handle(IPC.invoke.catspubLogout, () => service.logout());
  handle(IPC.invoke.catspubCaptchaStart, (request: CatspubCaptchaRequest) => service.startCaptcha(request));
  handle(IPC.invoke.catspubCaptchaUpdate, (request: CatspubCaptchaRequest) => service.updateCaptcha(request));
  handle(IPC.invoke.catspubCaptchaCancel, (id: string) => {
    if (typeof id !== "string") throw new Error("CATSPUB_INVALID_REQUEST");
    service.cancelCaptcha(id);
  });
}

const managedChannels: ReadonlySet<string> = new Set([
  IPC.invoke.providersCreate, IPC.invoke.providersUpdate, IPC.invoke.providersDelete,
  IPC.invoke.providersSetSecret, IPC.invoke.providersOauthStart, IPC.invoke.providersOauthRespond,
  IPC.invoke.providersOauthDelete, IPC.invoke.modelConfigImportRun,
]);
const workChannels: ReadonlySet<string> = new Set([
  IPC.invoke.agentPrompt, IPC.invoke.agentSteer, IPC.invoke.agentCompact, IPC.invoke.agentQueuePush,
]);
export function assertCatspubChannel(service: CatspubService, channel: string) {
  if (managedChannels.has(channel)) throw Object.assign(new Error("CATSPUB_MANAGED_PROVIDERS"), { errorCode: "PERMISSION_DENIED" });
  if (workChannels.has(channel) && !service.isAuthenticated()) {
    throw Object.assign(new Error("CATSPUB_SESSION_EXPIRED"), { errorCode: "CATSPUB_SESSION_EXPIRED" });
  }
}
