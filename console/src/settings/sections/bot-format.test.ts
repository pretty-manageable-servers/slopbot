import { describe, expect, test } from "vitest";
import type { Llm } from "../../api-types";
import { addKeyBody, capsProblem, keyErrorText, llmBody, llmFormFrom, llmProblem, llmStateText, secretProblem, type LlmForm } from "./bot-format";

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
  test("an unchanged form keeps the saved backup key", () => {
    const body = llmBody(llmFormFrom(saved));
    expect(body.fallback).toEqual({ baseUrl: "https://models.example.com/v1", model: "small-model", zdr: false, contextTokens: 32768, outputTokens: 4096 });
    expect(body.fallback).not.toHaveProperty("key");
  });

  test("a typed key is sent trimmed, and clearing sends an empty key", () => {
    expect(llmBody(form({ key: "  sk-new-secret-123  " })).fallback?.key).toBe("sk-new-secret-123");
    expect(llmBody(form({ clearKey: true })).fallback?.key).toBe("");
  });

  test("without a base URL no backup model is sent, so the saved one stays", () => {
    const body = llmBody(form({ backup: { ...llmFormFrom(saved).backup, baseUrl: "  " } }));
    expect(body).not.toHaveProperty("fallback");
    expect(body.breaker).toEqual(saved.settings.breaker);
  });
});

describe("llmProblem", () => {
  test("a form from the saved settings is valid", () => {
    expect(llmProblem(llmFormFrom(saved))).toBeNull();
  });

  test("the max cooldown must not be below the cooldown", () => {
    expect(llmProblem(form({ breaker: { ...saved.settings.breaker, maxCooldownSeconds: 120 } }))).toMatch(/Max cooldown/);
  });

  test("an empty number is a problem", () => {
    expect(llmProblem(form({ breaker: { ...saved.settings.breaker, failures: Number.NaN } }))).toMatch(/Failures/);
  });

  test("output tokens must be below context tokens", () => {
    expect(llmProblem(form({ backup: { ...llmFormFrom(saved).backup, outputTokens: 32768 } }))).toMatch(/Output tokens/);
  });

  test("a key that is not 8 to 200 characters with no spaces is a problem", () => {
    expect(llmProblem(form({ key: "short" }))).toMatch(/API key/);
    expect(llmProblem(form({ key: "has a space" }))).toMatch(/API key/);
    expect(llmProblem(form({ key: "sk-long-enough-1" }))).toBeNull();
  });

  test("a key without a base URL is a problem, since nothing would be saved", () => {
    expect(llmProblem(form({ key: "sk-long-enough-1", backup: { ...llmFormFrom(saved).backup, baseUrl: "" } }))).toMatch(/base URL/);
  });
});

describe("llmStateText", () => {
  test("a breaker fallback shows the backup mode, its source and the last error", () => {
    const text = llmStateText({ mode: "fallback", source: "breaker", since: 0, lastError: "timeout" });
    expect(text).toContain("Backup model");
    expect(text).toContain("set by the circuit breaker");
    expect(text).toContain("Last error: timeout.");
  });

  test("an admin override with no error has no error sentence", () => {
    const text = llmStateText({ mode: "normal", source: "override", since: 0 });
    expect(text).toContain("Normal");
    expect(text).toContain("set by an admin");
    expect(text).not.toContain("Last error");
  });
});

describe("web keys", () => {
  test("a secret is 8 to 200 printable characters with no spaces", () => {
    expect(secretProblem("1234567")).not.toBeNull();
    expect(secretProblem("12345678")).toBeNull();
    expect(secretProblem("1234 5678")).not.toBeNull();
    expect(secretProblem("a".repeat(201))).not.toBeNull();
  });

  test("the add body trims the label", () => {
    expect(addKeyBody({ provider: "tavily", label: "  team  ", secret: "tvly-abcdef" })).toEqual({ provider: "tavily", label: "team", secret: "tvly-abcdef" });
  });

  test("caps are whole numbers from 1 to 100000", () => {
    expect(capsProblem({ tavily: 1000, firecrawl: 100000 })).toBeNull();
    expect(capsProblem({ tavily: 0, firecrawl: 500 })).not.toBeNull();
    expect(capsProblem({ tavily: 1000, firecrawl: 100001 })).not.toBeNull();
    expect(capsProblem({ tavily: Number.NaN, firecrawl: 500 })).not.toBeNull();
  });

  test("a key error shows its status, message and how long ago it was", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    const text = keyErrorText({ at: now - 5 * 60_000, status: "429", message: "rate limited", exhausted: false }, now);
    expect(text).toBe("429 · rate limited · 5 min ago");
  });
});
