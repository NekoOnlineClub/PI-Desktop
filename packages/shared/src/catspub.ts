/** Public Catspub contracts. Authentication material never crosses renderer IPC. */
export const CATSPUB_ORIGIN = "https://catspub.com";
export const CATSPUB_AUTH_KIND = "catspub";
export function isDynamicProviderAuth(authKind: string | undefined): boolean {
  return authKind === "oauth" || authKind === CATSPUB_AUTH_KIND;
}
export const CONTEXT_WINDOW_TIERS = [32000, 64000, 128000, 256000, 1000000] as const;
export type ContextWindowTier = (typeof CONTEXT_WINDOW_TIERS)[number];

export function isContextWindowTier(value: unknown): value is ContextWindowTier {
  return (CONTEXT_WINDOW_TIERS as readonly unknown[]).includes(value);
}

export function sessionContextWindow(modelLimit: number | undefined, tier?: number | null): number {
  const limit = modelLimit && Number.isFinite(modelLimit) && modelLimit > 0 ? modelLimit : 128000;
  return isContextWindowTier(tier) ? Math.min(limit, tier) : limit;
}

export type CatspubProfile = {
  id: number;
  username: string;
  displayName: string;
  group: string;
  balance: number;
  currency: string;
};

export type CatspubLoginOptions = {
  password: boolean;
  github: boolean;
  passkey: boolean;
  captcha: boolean;
};

export type CatspubChallenge = {
  expiresAt: number;
  methods: Array<{ method: string; available: boolean; reason?: string }>;
};

export type CatspubState = {
  status: "anonymous" | "verification" | "authenticated";
  options: CatspubLoginOptions;
  profile?: CatspubProfile;
  challenge?: CatspubChallenge;
  catalogUpdatedAt?: string;
  catalogError?: boolean;
};

export type CatspubLoginInput = {
  username: string;
  password: string;
  rememberLogin: boolean;
  captchaId?: string;
};

export type CatspubCaptchaBounds = { x: number; y: number; width: number; height: number };
export type CatspubCaptchaRequest = {
  id: string;
  bounds: CatspubCaptchaBounds;
  theme: "light" | "dark";
};

export type CatspubBrowserMethod = "github" | "passkey";
