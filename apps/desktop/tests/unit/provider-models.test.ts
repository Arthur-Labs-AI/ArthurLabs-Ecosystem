import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL_VALUE,
  DEEPSEEK_MODELS,
  LEGACY_DEEPSEEK_ALIASES,
  OPENCODE_GO_MODELS,
  OPENCODE_ZEN_MODELS,
  ZAI_GLM_MODELS,
  modelsForOpenCodeMode,
  resolveOpenCodeModelMode,
  stripKnownOpenCodePrefix,
  resolveOpenCodeBinarySuggestion,
  suggestManagedOpenCodeBinary,
} from "../../src/renderer/lib/provider-models.js";

describe("provider model catalogs", () => {
  // The official Go docs Model ID table publishes exactly 29 ids (Go and Go
  // Plus share this list). A previous draft asserted 37 invented entries;
  // corrected here to the published list — see provider-models.ts sources.
  it("covers the current Go subscription lineup", () => {
    expect(OPENCODE_GO_MODELS).toHaveLength(29);
    for (const id of ["glm-5.3-flash", "gpt-6-luna", "claude-haiku-5-5", "deepseek-v4.1-flash", "kimi-k3.1-pro", "gemini-4-argon"]) {
      expect(OPENCODE_GO_MODELS).toContain(id);
    }
    expect(new Set(OPENCODE_GO_MODELS).size).toBe(OPENCODE_GO_MODELS.length);
  });

  it("covers the Zen pay-as-you-go lineup without free-tier entries", () => {
    expect(OPENCODE_ZEN_MODELS.length).toBeGreaterThan(50);
    for (const id of ["gpt-6-luna", "claude-opus-4-6", "gemini-4-argon", "deepseek-v4-pro", "kimi-k3", "glm-5.3"]) {
      expect(OPENCODE_ZEN_MODELS).toContain(id);
    }
    expect(OPENCODE_ZEN_MODELS.every((id) => !id.endsWith("-free"))).toBe(true);
    expect(new Set(OPENCODE_ZEN_MODELS).size).toBe(OPENCODE_ZEN_MODELS.length);
  });

  it("lists the current DeepSeek API models first", () => {
    expect(DEEPSEEK_MODELS.slice(0, 2)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(DEEPSEEK_MODELS).toContain("deepseek-v4-flash");
  });

  it("marks retired DeepSeek aliases as legacy, not current", () => {
    expect(LEGACY_DEEPSEEK_ALIASES).toContain("deepseek-v4-flash");
    expect(DEEPSEEK_MODELS.slice(0, 2)).not.toContain("deepseek-v4-flash");
  });

  it("lists the Z.AI GLM lineup", () => {
    expect(ZAI_GLM_MODELS).toContain("glm-5.3-flash");
    expect(ZAI_GLM_MODELS).toContain("glm-5");
    expect(new Set(ZAI_GLM_MODELS).size).toBe(ZAI_GLM_MODELS.length);
  });

  it("resolves the OpenCode entry mode from the provider value", () => {
    expect(resolveOpenCodeModelMode("opencode-go")).toBe("go");
    expect(resolveOpenCodeModelMode("  OpenCode-Go ")).toBe("go");
    expect(resolveOpenCodeModelMode("opencode")).toBe("zen");
    expect(resolveOpenCodeModelMode("openrouter")).toBe("manual");
    expect(resolveOpenCodeModelMode("")).toBe("manual");
    expect(resolveOpenCodeModelMode(undefined)).toBe("manual");
    expect(modelsForOpenCodeMode("go")).toBe(OPENCODE_GO_MODELS);
    expect(modelsForOpenCodeMode("zen")).toBe(OPENCODE_ZEN_MODELS);
    expect(modelsForOpenCodeMode("manual")).toEqual([]);
  });

  it("strips known provider prefixes for catalog comparison only", () => {
    expect(stripKnownOpenCodePrefix("opencode-go/kimi-k3")).toBe("kimi-k3");
    expect(stripKnownOpenCodePrefix("openrouter/anthropic/claude-x")).toBe("anthropic/claude-x");
    expect(stripKnownOpenCodePrefix("kimi-k3")).toBe("kimi-k3");
    expect(stripKnownOpenCodePrefix("other-vendor/some-model")).toBe("other-vendor/some-model");
  });

  it("reserves a custom sentinel distinct from real model ids", () => {
    const all = [...OPENCODE_GO_MODELS, ...OPENCODE_ZEN_MODELS, ...DEEPSEEK_MODELS, ...ZAI_GLM_MODELS];
    expect(all).not.toContain(CUSTOM_MODEL_VALUE);
  });

  it("derives the managed OpenCode path from sibling home directories", () => {
    const deepseek = { name: "SENTRY_DEEPSEEK_BINARY", configured: true, hint: "/home/merte/.local/share/sentry/tools/deepseek/bin/dsh" };
    expect(suggestManagedOpenCodeBinary([deepseek])).toEqual({
      path: "/home/merte/.local/share/sentry/tools/opencode/node_modules/.bin/opencode",
      from: "SENTRY_DEEPSEEK_BINARY",
    });
    const glm = { name: "SENTRY_GLM_BINARY", configured: true, hint: "/home/ana/.local/bin/claude" };
    expect(suggestManagedOpenCodeBinary([glm])).toEqual({
      path: "/home/ana/.local/share/sentry/tools/opencode/node_modules/.bin/opencode",
      from: "SENTRY_GLM_BINARY",
    });
    // DeepSeek wins over GLM; unconfigured and missing hints are skipped.
    expect(
      suggestManagedOpenCodeBinary([
        { name: "SENTRY_DEEPSEEK_BINARY", configured: false, hint: "missing" },
        glm,
      ])?.from,
    ).toBe("SENTRY_GLM_BINARY");
    expect(suggestManagedOpenCodeBinary([])).toBeUndefined();
    expect(
      suggestManagedOpenCodeBinary([
        { name: "SENTRY_DEEPSEEK_BINARY", configured: true, hint: "missing" },
        { name: "SENTRY_GLM_BINARY", configured: true, hint: "C:\\tools\\claude.exe" },
      ]),
    ).toBeUndefined();
  });

  it("prefers live detection over the sibling heuristic", () => {
    const sibling = { name: "SENTRY_DEEPSEEK_BINARY", configured: true, hint: "/home/merte/.local/share/sentry/tools/deepseek/bin/dsh" };
    expect(
      resolveOpenCodeBinarySuggestion({ path: "/opt/opencode/bin/opencode", available: true }, [sibling]),
    ).toEqual({ path: "/opt/opencode/bin/opencode", source: "detected" });
    // Unavailable detection (managed default with nothing installed) falls back.
    expect(
      resolveOpenCodeBinarySuggestion({ path: "/home/merte/.local/share/sentry/tools/opencode/node_modules/.bin/opencode", available: false }, [sibling]),
    ).toEqual({
      path: "/home/merte/.local/share/sentry/tools/opencode/node_modules/.bin/opencode",
      source: "sibling",
    });
    // Garbage detection falls back too.
    expect(
      resolveOpenCodeBinarySuggestion({ path: "C:\\tools\\opencode.exe", available: true }, [sibling])?.source,
    ).toBe("sibling");
    expect(resolveOpenCodeBinarySuggestion(undefined, [])).toBeUndefined();
  });
});
