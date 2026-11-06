import { describe, expect, test } from "vitest";
import type { Llm } from "../../api-types";
import { capsProblem, llmBody, llmFormFrom, llmProblem, secretProblem, type LlmForm } from "./bot-format";

const saved: Llm = {
  settings: {
    override: "auto",
    breaker: { failures: 3, windowSeconds: 120, cooldownSeconds: 300, maxCooldownSeconds: 3600 },
    statusNoteMinutes: 15,
    fallback: { baseUrl: "https://models.example.com/v1", model: "small-model", zdr: false, contextTokens: 32768, outputTokens: 4096, keyLast4: "a1b2" },
  },
  state: { mode: "normal", source: "breaker", since: 0 },
};

const form = (change: Partial<LlmForm> = {}): LlmForm => ({ ...llmFormFrom(saved), ...change });

describe("llmBody", () => {
  test("the saved backup key is kept unless a key is typed or cleared", () => {
    const body = llmBody(llmFormFrom(saved));
    expect(body.fallback).toEqual({ baseUrl: "https://models.example.com/v1", model: "small-model", zdr: false, contextTokens: 32768, outputTokens: 4096 });
    expect(body.fallback).not.toHaveProperty("key");
    expect(llmBody(form({ key: "  sk-new-secret-123  " })).fallback?.key).toBe("sk-new-secret-123");
    expect(llmBody(form({ clearKey: true })).fallback?.key).toBe("");
  });

  test("without a base URL no backup model is sent, so the saved one stays", () => {
    const body = llmBody(form({ backup: { ...llmFormFrom(saved).backup, baseUrl: "  " } }));
    expect(body).not.toHaveProperty("fallback");
  });
});

describe("llmProblem", () => {
  test("the saved settings are valid", () => {
    expect(llmProblem(llmFormFrom(saved))).toBeNull();
  });

  test("invalid forms are refused", () => {
    const backup = llmFormFrom(saved).backup;
    const bad = [
      form({ breaker: { ...saved.settings.breaker, maxCooldownSeconds: 120 } }),
      form({ breaker: { ...saved.settings.breaker, failures: Number.NaN } }),
      form({ backup: { ...backup, outputTokens: 32768 } }),
      form({ key: "short" }),
      form({ key: "has a space" }),
      form({ key: "sk-long-enough-1", backup: { ...backup, baseUrl: "" } }),
    ];
    for (const f of bad) expect(llmProblem(f)).not.toBeNull();
    expect(llmProblem(form({ key: "sk-long-enough-1" }))).toBeNull();
  });
});

describe("web keys", () => {
  test("a secret is 8 to 200 printable characters with no spaces", () => {
    expect(secretProblem("1234567")).not.toBeNull();
    expect(secretProblem("12345678")).toBeNull();
    expect(secretProblem("1234 5678")).not.toBeNull();
    expect(secretProblem("a".repeat(201))).not.toBeNull();
  });

  test("caps are whole numbers from 1 to 100000", () => {
    expect(capsProblem({ tavily: 1000, firecrawl: 100000 })).toBeNull();
    expect(capsProblem({ tavily: 0, firecrawl: 500 })).not.toBeNull();
    expect(capsProblem({ tavily: 1000, firecrawl: 100001 })).not.toBeNull();
    expect(capsProblem({ tavily: Number.NaN, firecrawl: 500 })).not.toBeNull();
  });
});
