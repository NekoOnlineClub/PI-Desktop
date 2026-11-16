import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, GitBranch, KeyRound, LoaderCircle, RefreshCw } from "lucide-react";
import type { CatspubState } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Checkbox, Field, Input, PasswordInput } from "../../components/ui";
import { WindowControls } from "../../components/WindowControls";
import { InlineCaptcha } from "./InlineCaptcha";
import { resetAccountCatalog } from "../../stores/app-store";
import logo from "../../assets/brand/logo-light.png";
import "../../styles/catspub.css";

const AuthContext = createContext<{
  state: CatspubState;
  update: (state: CatspubState) => void;
  logout: () => Promise<void>;
} | null>(null);

export function useCatspub() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("Catspub auth context missing");
  return context;
}

export function catspubErrorKey(error: unknown): string {
  const code = (error as { code?: string; errorCode?: string })?.code ?? (error as { errorCode?: string })?.errorCode;
  if (code === "CATSPUB_NETWORK_ERROR") return "catspub.networkError";
  if (code === "CATSPUB_RATE_LIMITED") return "catspub.rateLimited";
  if (code === "CATSPUB_CANCELLED") return "catspub.cancelled";
  if (code === "CATSPUB_SESSION_EXPIRED") return "catspub.sessionExpired";
  if (code === "CATSPUB_CAPTCHA_REQUIRED") return "catspub.captchaRequired";
  return "catspub.requestFailed";
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CatspubState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const accountId = useRef<number | undefined>(undefined);

  const update = (next: CatspubState) => {
    const id = next.status === "authenticated" ? next.profile?.id : undefined;
    if (id !== accountId.current) resetAccountCatalog();
    accountId.current = id;
    setState(next);
  };

  const initialize = async () => {
    setLoading(true); setError(null);
    try { const next = await api.catspubState(); if (mounted.current) update(next); }
    catch (reason) { if (mounted.current) setError(catspubErrorKey(reason)); }
    finally { if (mounted.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void initialize();
    return () => { mounted.current = false; };
  }, []);

  // Refresh expiry is also observed while the shell is mounted.
  useEffect(() => {
    if (state?.status !== "authenticated") return;
    const interval = window.setInterval(() => {
      const id = requestId.current;
      void api.catspubState().then((next) => {
        if (mounted.current && id === requestId.current) {
          update(next);
          if (next.status === "anonymous") setError("catspub.sessionExpired");
        }
      }).catch(() => {});
    }, 30000);
    return () => window.clearInterval(interval);
  }, [state?.status]);

  async function run(operation: () => Promise<CatspubState>) {
    const id = ++requestId.current;
    setBusy(true); setError(null);
    try {
      const next = await operation();
      if (mounted.current && id === requestId.current) { update(next); setPassword(""); setCode(""); }
    } catch (reason) {
      if (id === requestId.current) {
        setError(catspubErrorKey(reason));
        if (state?.status !== "verification") {
          await api.catspubCancel().catch(() => {});
          if (id === requestId.current) {
            setCaptchaId(null);
            setCaptchaAttempt((value) => value + 1);
          }
        }
      }
    } finally { if (id === requestId.current) setBusy(false); }
  }

  async function cancel() {
    ++requestId.current;
    try { update(await api.catspubCancel()); setError(null); }
    catch (reason) { setError(catspubErrorKey(reason)); }
    finally { setBusy(false); setPassword(""); setCode(""); setCaptchaId(null); setCaptchaAttempt((value) => value + 1); }
  }

  async function logout() {
    ++requestId.current;
    setBusy(true); setError(null); setPassword(""); setCode(""); setRemember(false);
    if (state) update({ status: "anonymous", options: state.options });
    try {
      const result = await api.catspubLogout();
      setError(result.revoked ? null : "catspub.localLogoutComplete");
    } catch { setError("catspub.localLogoutComplete"); }
    finally { setBusy(false); }
  }

  if (state?.status === "authenticated") {
    return <AuthContext.Provider value={{ state, update, logout }}>{children}</AuthContext.Provider>;
  }
  const verification = state?.status === "verification";
  return (
    <main className="catspub-login" data-testid="catspub-login">
      <div className="catspub-login-drag" />
      <section className="catspub-login-form">
        <img className="catspub-login-logo" src={logo} alt="" />
        <h1>Catspub</h1>
        <p className="catspub-login-site">catspub.com</p>
        <h2>{t(verification ? "catspub.verifyTitle" : "catspub.loginTitle")}</h2>
        {loading ? <div className="catspub-loading" role="status"><LoaderCircle size={20} className="catspub-spin" />{t("catspub.connecting")}</div> : (
          <>
            {error ? <p className="catspub-error" role="alert">{t(error)}</p> : null}
            {!state ? <Button onClick={() => void initialize()}><RefreshCw size={16} />{t("catspub.retry")}</Button> : (
              <>
                <form onSubmit={(event) => {
                  event.preventDefault();
                  if (busy) return;
                  if (!verification && state.options.captcha && !captchaId) return;
                  if (verification) void run(() => api.catspubVerify(code));
                  else void run(() => api.catspubLogin({ username, password, rememberLogin: remember, captchaId: captchaId ?? undefined }));
                }}>
                  {verification ? (
                    <Field label={t("catspub.verificationCode")}>
                      <Input autoFocus autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required disabled={busy} maxLength={32} />
                    </Field>
                  ) : (
                    <>
                      <Field label={t("catspub.username")}><Input name="username" autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required disabled={busy} maxLength={256} /></Field>
                      <Field label={t("catspub.password")}><PasswordInput name="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy}
                        showLabel={t("catspub.showPassword")} hideLabel={t("catspub.hidePassword")} /></Field>
                      <Checkbox label={t("catspub.rememberLogin")} checked={remember} onChange={(event) => setRemember(event.target.checked)} disabled={busy} />
                      {state.options.captcha && state.options.password ? <InlineCaptcha attempt={captchaAttempt} onReady={setCaptchaId} /> : null}
                    </>
                  )}
                  {(verification ? state.challenge?.methods.some((m) => m.method === "2fa" && m.available) : state.options.password) ? (
                    <Button variant="primary" className="catspub-login-submit" type="submit" disabled={busy || !verification && state.options.captcha && !captchaId}>
                      {busy ? <LoaderCircle size={16} className="catspub-spin" /> : <ArrowRight size={16} />}
                      {t(verification ? "catspub.verify" : "catspub.signIn")}
                    </Button>
                  ) : null}
                </form>
                {!verification && (state.options.github || state.options.passkey) ? <div className="catspub-login-divider" /> : null}
                <div className="catspub-login-alternatives">
                  {!verification && state.options.github ? <Button disabled={busy} onClick={() => void run(() => api.catspubBrowserLogin("github", remember))}><GitBranch size={16} />GitHub</Button> : null}
                  {(verification ? state.challenge?.methods.some((m) => m.method === "passkey" && m.available) : state.options.passkey) ? <Button disabled={busy} onClick={() => void run(() => api.catspubBrowserLogin("passkey", remember))}><KeyRound size={16} />Passkey</Button> : null}
                </div>
                {busy || verification ? <Button variant="ghost" className="catspub-login-cancel" onClick={() => void cancel()}>{t("catspub.cancel")}</Button> : null}
              </>
            )}
          </>
        )}
      </section>
      <WindowControls />
    </main>
  );
}
