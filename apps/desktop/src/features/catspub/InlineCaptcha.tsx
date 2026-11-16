import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";

export function InlineCaptcha({ attempt, onReady }: { attempt: number; onReady: (id: string | null) => void }) {
  const { t } = useTranslation();
  const field = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const id = crypto.randomUUID();
    let disposed = false;
    let frame = 0;
    let expiry: number | undefined;
    const request = () => {
      const bounds = element.getBoundingClientRect();
      return { id, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        theme: document.documentElement.dataset.theme === "light" ? "light" as const : "dark" as const };
    };
    const reposition = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!disposed) void api.catspubCaptchaUpdate(request()).catch(() => {});
      });
    };
    setStatus("loading");
    onReady(null);
    void api.catspubCaptchaStart(request()).then(() => {
      if (disposed) return;
      setStatus("ready");
      onReady(id);
      expiry = window.setTimeout(() => setRetry((value) => value + 1), 230000);
    }).catch(() => {
      if (!disposed) { setStatus("error"); onReady(null); }
    });
    const resize = new ResizeObserver(reposition);
    resize.observe(element);
    const form = element.closest(".catspub-login-form");
    if (form) resize.observe(form);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(expiry);
      resize.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      void api.catspubCaptchaCancel(id).catch(() => {});
    };
  }, [attempt, retry, onReady]);

  return <div className="catspub-captcha" role="group" aria-label={t("catspub.humanVerification")}>
    <span className="catspub-captcha-label">{t("catspub.humanVerification")}</span>
    <div ref={field} className="catspub-captcha-field" data-status={status}>
      {status === "ready" ? <span role="status"><CircleCheck size={18} />{t("catspub.captchaVerified")}</span>
        : status === "error" ? <Button size="sm" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={16} />{t("catspub.captchaRetry")}</Button>
        : <span role="status"><LoaderCircle size={18} className="catspub-spin" />{t("catspub.captchaLoading")}</span>}
    </div>
  </div>;
}
