import { describe, expect, it } from "vitest";
import { CONTEXT_WINDOW_TIERS, isContextWindowTier, sessionContextWindow } from "./catspub.js";
import { IPC, IPC_WHITELIST } from "./protocol.js";

describe("Catspub public contracts", () => {
  it("exposes only the fixed context tiers and clamps them to model capacity", () => {
    expect(CONTEXT_WINDOW_TIERS).toEqual([32000, 64000, 128000, 256000, 1000000]);
    expect(isContextWindowTier(123)).toBe(false);
    expect(sessionContextWindow(200000, null)).toBe(200000);
    expect(sessionContextWindow(200000, 32000)).toBe(32000);
    expect(sessionContextWindow(200000, 1000000)).toBe(200000);
    expect(sessionContextWindow(undefined, null)).toBe(128000);
    expect(sessionContextWindow(Number.NaN, 256000)).toBe(128000);
  });

  it("admits the authentication IPC without exposing a credential getter", () => {
    for (const [key, channel] of Object.entries(IPC.invoke)) {
      if (key.startsWith("catspub")) expect(IPC_WHITELIST.has(channel)).toBe(true);
    }
    expect(Object.keys(IPC.invoke).filter((key) => key.startsWith("catspub"))).toHaveLength(10);
  });
});
