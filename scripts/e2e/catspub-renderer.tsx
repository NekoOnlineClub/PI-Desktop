import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { useEffect, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { zhCN } from "@pi-desktop/i18n";
import { AuthGate } from "../../apps/desktop/src/features/catspub/AuthGate";
import { ProfileButton } from "../../apps/desktop/src/features/catspub/ProfileButton";
import { SiteModelsPage } from "../../apps/desktop/src/features/catspub/SiteModelsPage";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function Shell() {
  const [failure, setFailure] = useState("");
  const [wide, setWide] = useState(innerWidth >= 760);
  useEffect(() => {
    const media = matchMedia("(min-width: 760px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const directory = await api.listProviders();
      const result = await api.createSession({ title: "Catspub context test", mode: "agent", providerId: directory.providers[0].id, modelId: directory.providers[0].models[0].id });
      if (mounted) useAppStore.setState({ providers: directory.providers, sessions: (await api.listSessions()).sessions,
        activeSessionId: result.session.id, ready: true });
    })().catch((error) => setFailure(String(error)));
    return () => { mounted = false; };
  }, []);
  return <div data-testid="authenticated-shell" style={{ height: "100dvh", display: "flex" }}>
    {wide ? <div style={{ width: 240, flex: "0 0 240px", minHeight: 0, "--ds-sidebar-width": "240px" } as CSSProperties}>
      <Sidebar onToggleSidebar={() => {}} sidebarToggleShortcut="" sidebarWidth={240}
        onWidthChange={() => {}} onWidthCommit={() => {}} onResizeCollapse={() => {}} />
    </div> : null}
    <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", padding: 24, gap: 20 }}>
      {failure ? <p role="alert">{failure}</p> : null}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}><SiteModelsPage /></div>
      <Composer variant="home" />
      {!wide ? <div><ProfileButton /></div> : null}
    </main>
  </div>;
}

const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function until<T>(predicate: () => T, name: string): Promise<NonNullable<T>> {
  const end = performance.now() + 20000;
  for (;;) {
    const value = predicate(); if (value) return value as NonNullable<T>;
    if (performance.now() > end) throw new Error(`Timed out waiting for ${name}: ${document.body.innerText}`);
    await settle();
  }
}
function fill(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function clickText(text: string, scope: ParentNode = document) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  button.click();
}
const snapshot = () => {
  const state = useAppStore.getState();
  return { providerIds: state.providers.map((row) => row.id), modelIds: state.providers.flatMap((row) => row.models.map((model) => model.id)),
    sessionId: state.activeSessionId, context: state.sessions.find((row) => row.id === state.activeSessionId)?.contextWindowLimit,
    groups: state.providers.map((row) => row.name), thinking: state.sessions.find((row) => row.id === state.activeSessionId)?.thinkingLevel };
};
const ready = async () => { await until(() => useAppStore.getState().ready && document.querySelector("[data-testid=authenticated-shell]"), "authenticated shell"); await settle(); return snapshot(); };
Object.assign(globalThis, { catspubProbe: {
  async initial() {
    const input = await until(() => document.querySelector<HTMLInputElement>("input[name=username]"), "login form");
    return { remember: document.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked, logo: document.querySelector<HTMLImageElement>(".catspub-login-logo")?.naturalWidth,
      formWidth: input.getBoundingClientRect().width };
  },
  async password() {
    fill(document.querySelector<HTMLInputElement>("input[name=username]")!, "alice");
    fill(document.querySelector<HTMLInputElement>("input[name=password]")!, "fixture-password");
    await settle(); document.querySelector("form")!.requestSubmit();
    await until(() => document.querySelector("input[autocomplete=one-time-code]"), "MFA form");
    fill(document.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!, "123456");
    await settle(); document.querySelector("form")!.requestSubmit();
    return ready();
  },
  async captchaReady() { await until(() => document.querySelector(".catspub-captcha-field[data-status=ready]"), "verified inline CAPTCHA"); },
  async captchaReflow(expanded: boolean) {
    const heading = document.querySelector<HTMLElement>(".catspub-login h2")!;
    heading.style.marginBottom = expanded ? "80px" : "";
    await settle();
  },
  captchaBounds() {
    const rect = document.querySelector(".catspub-captcha-field")!.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  },
  async context(value: string) {
    const select = document.querySelector<HTMLSelectElement>(".catspub-context-select")!;
    const disabled = [...select.options].filter((option) => option.disabled).map((option) => option.value);
    select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
    const expected = value === "auto" ? null : Number(value);
    await until(() => snapshot().context === expected || expected === null && snapshot().context === undefined, "saved context tier");
    return { ...snapshot(), disabled };
  },
  async profile() {
    document.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("catspub.profile")}"]`)!.click();
    const menu = await until(() => document.querySelector<HTMLElement>(".catspub-profile.is-open"), "profile menu");
    await settle(); return menu.innerText;
  },
  async refreshProfile(expected: string) {
    clickText(i18n.t("catspub.refresh"), document.querySelector(".catspub-profile")!);
    await until(() => document.querySelector(".catspub-balance")?.textContent?.includes(expected), "wallet refresh");
    return document.querySelector<HTMLElement>(".catspub-profile")!.innerText;
  },
  async closeProfile() { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle(); },
  async modelGroups() {
    document.querySelector<HTMLButtonElement>(".composer-model-thinking-chip")!.click();
    await until(() => document.querySelectorAll(".composer-model-rail [role=menuitemradio]").length > 1, "model group menu");
    const groups = [...document.querySelectorAll(".composer-model-rail [role=menuitemradio]")].map((row) => row.textContent);
    await settle(); return groups;
  },
  async selectGroupModel(group: string, model: string) {
    const label = [...document.querySelectorAll(".composer-model-rail-label")].find((item) => item.textContent === group);
    if (!label) throw new Error(`Missing model group: ${group}`);
    label.closest("button")!.click();
    await settle();
    const option = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".composer-model-menu button")]
      .find((button) => button.textContent?.includes(model)), "group model option");
    option.click();
    await until(() => {
      const state = useAppStore.getState();
      const session = state.sessions.find((row) => row.id === state.activeSessionId);
      return session?.modelId === model && state.providers.find((row) => row.id === session.providerId)?.name === group;
    }, "selected group model");
    await settle(); return snapshot();
  },
  async reasoning(level: string) {
    if (!document.querySelector(".composer-model-menu.is-open")) document.querySelector<HTMLButtonElement>(".composer-model-thinking-chip")!.click();
    await settle();
    const tick = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".composer-model-menu.is-open .composer-thinking-tick")]
      .find((item) => item.textContent?.trim() === level), "reasoning level");
    tick.click();
    await until(() => snapshot().thinking === level, "saved reasoning level");
    document.querySelector<HTMLButtonElement>(".composer-model-thinking-chip")!.click();
    await settle(); return snapshot();
  },
  async chrome() {
    await settle();
    const brand = document.querySelector<HTMLElement>(".brand > span");
    const model = await until(() => document.querySelector<HTMLElement>(".composer-model-thinking-model"), "selected model label");
    const level = document.querySelector<HTMLElement>(".composer-model-thinking-level");
    const visible = (element: HTMLElement | null) => Boolean(element && element.getBoundingClientRect().width > 0 && getComputedStyle(element).display !== "none");
    return { brand: brand?.textContent, brandFits: !brand || brand.scrollWidth <= brand.clientWidth + 1,
      footerVersion: Boolean(document.querySelector(".footer-build")), model: model.textContent, level: level?.textContent,
      modelVisible: visible(model), levelVisible: visible(level),
      labelsOverlap: Boolean(level && model.getBoundingClientRect().right > level.getBoundingClientRect().left + 1) };
  },
  async logout() {
    if (!document.querySelector(".catspub-profile.is-open")) await (globalThis as any).catspubProbe.profile();
    clickText(i18n.t("catspub.signOut"), document.querySelector(".catspub-profile")!);
    await until(() => document.querySelector<HTMLInputElement>("input[name=username]") && !document.querySelector<HTMLInputElement>("input[name=username]")!.disabled, "logout completion");
    return { providers: useAppStore.getState().providers.length, message: document.querySelector("[role=alert]")?.textContent };
  },
  async browser(method: string) { clickText(method); return ready(); },
  async layout() {
    await settle();
    const selectors = [".catspub-login-form", ".catspub-profile.is-open", ".catspub-context-select", ".catspub-directory-toolbar", ".composer-toolbar", ".composer-model-thinking-chip", ".sidebar-header"];
    const overflow = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => {
      const rect = element.getBoundingClientRect(); return rect.width > innerWidth || rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1;
    }).map(() => selector));
    return { width: innerWidth, height: innerHeight, overflow, pageOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight + 1 };
  },
} });
void i18n.use(initReactI18next).init({ lng: "zh-CN", fallbackLng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } }).then(() => {
  createRoot(document.getElementById("root")!).render(<AuthGate><Shell /></AuthGate>);
});
