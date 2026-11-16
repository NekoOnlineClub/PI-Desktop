import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { catspubErrorKey, useCatspub } from "./AuthGate";

export function SiteModelsPage() {
  const { t } = useTranslation();
  const { state, update } = useCatspub();
  const providers = useAppStore((s) => s.providers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="catspub-model-directory">
    <div className="catspub-directory-toolbar"><h2>{t("catspub.availableModels")}</h2><Button size="sm" disabled={busy} onClick={() => {
      setBusy(true); setError(null);
      void api.catspubRefresh().then(async (state) => { update(state); await useAppStore.getState().refreshProviders(); })
        .catch((reason) => setError(catspubErrorKey(reason))).finally(() => setBusy(false));
    }}><RefreshCw size={14} />{t("catspub.refresh")}</Button></div>
    {error ? <p role="alert" className="catspub-error">{t(error)}</p> : null}
    {state.catalogError ? <p role="alert" className="catspub-error">{t("catspub.catalogError")}</p> : null}
    {!providers.length ? <p>{t("catspub.noModels")}</p> : providers.map((provider) => <section key={provider.id}>
      <h3>{provider.name}<span>{provider.models.length}</span></h3>
      <table><thead><tr><th>{t("catspub.model")}</th><th>{t("catspub.contextWindow")}</th></tr></thead><tbody>
        {provider.models.map((model) => <tr key={model.id}><td>{model.id}</td><td>{Math.round(model.contextWindow / 1000)}K{model.contextWindowEstimated ? ` (${t("catspub.estimated")})` : ""}</td></tr>)}
      </tbody></table>
    </section>)}
  </div>;
}
