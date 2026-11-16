import { useTranslation } from "react-i18next";
import { CONTEXT_WINDOW_TIERS, sessionContextWindow } from "@pi-desktop/shared";
import { Select } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";

export function ContextTierSelect({ providerId, modelId, disabled }: { providerId?: string; modelId?: string; disabled: boolean }) {
  const { t } = useTranslation();
  const session = useAppStore((s) => s.sessions.find((item) => item.id === s.activeSessionId));
  const draft = useAppStore((s) => s.draftConfiguration);
  const provider = useAppStore((s) => s.providers.find((item) => item.id === providerId));
  const binding = provider?.models.find((item) => item.id === modelId);
  const limit = binding?.contextWindow || 128000;
  const selected = (session ? session.contextWindowLimit : draft?.contextWindowLimit) ?? null;
  const effective = sessionContextWindow(limit, selected);
  return <Select className="catspub-context-select" aria-label={t("catspub.contextWindow")}
    title={`${t("catspub.contextWindow")}: ${Math.round(limit / 1000)}K${binding?.contextWindowEstimated ? ` (${t("catspub.estimated")})` : ""}`}
    value={selected ?? "auto"} disabled={disabled || !binding} onChange={(event) => {
      const contextWindowLimit = event.target.value === "auto" ? null : Number(event.target.value);
      const state = useAppStore.getState();
      void state.configureActiveSession({ mode: session?.mode ?? draft?.mode ?? "agent", providerId, modelId,
        thinkingLevel: session?.thinkingLevel ?? draft?.thinkingLevel ?? "off", contextWindowLimit })
        .catch(() => state.showToast(t("catspub.requestFailed"), { variant: "error" }));
    }}>
    <option value="auto">{t("catspub.autoContext")}</option>
    {CONTEXT_WINDOW_TIERS.map((tier) => <option value={tier} key={tier} disabled={tier > limit}>
      {tier === 1000000 ? "1M" : `${tier / 1000}K`}{selected === tier && tier > limit ? ` (${Math.round(effective / 1000)}K)` : ""}
    </option>)}
  </Select>;
}
