import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LogOut, RefreshCw, UserRound } from "lucide-react";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { Button, TooltipButton } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { catspubErrorKey, useCatspub } from "./AuthGate";

export function ProfileButton() {
  const { t, i18n } = useTranslation();
  const { state, update, logout } = useCatspub();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = state.profile;
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} side="top" align="start" role="dialog"
    label={t("catspub.profile")} menuClassName="settings-menu-select-menu catspub-profile" trigger={(ref) => (
      <TooltipButton ref={ref} tooltip={t("catspub.profile")} className="icon-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <UserRound size={17} />
      </TooltipButton>
    )}>
    <div className="catspub-profile-heading"><UserRound size={18} /><strong>{t("catspub.profile")}</strong></div>
    {profile ? <dl className="selectable">
      <div><dt>{t("catspub.username")}</dt><dd>{profile.username}</dd></div>
      <div><dt>{t("catspub.userId")}</dt><dd>{profile.id}</dd></div>
      <div><dt>{t("catspub.wallet")}</dt><dd className="catspub-balance">{new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 4 }).format(profile.balance)} <small>{profile.currency}</small></dd></div>
    </dl> : null}
    {state.catalogError ? <p className="catspub-error" role="alert">{t("catspub.catalogError")}</p> : null}
    {error ? <p className="catspub-error" role="alert">{t(error)}</p> : null}
    <div className="catspub-profile-actions">
      <Button size="sm" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void api.catspubRefresh().then(async (next) => { update(next); await useAppStore.getState().refreshProviders(); })
          .catch((reason) => setError(catspubErrorKey(reason))).finally(() => setBusy(false));
      }}><RefreshCw size={14} />{t("catspub.refresh")}</Button>
      <Button size="sm" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void logout().catch((reason) => { setError(catspubErrorKey(reason)); setBusy(false); });
      }}><LogOut size={14} />{t("catspub.signOut")}</Button>
    </div>
  </AnchoredMenu>;
}
