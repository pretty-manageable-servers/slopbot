import { describe, expect, test } from "vitest";
import {
  LIMITS_RULES, PRICE_RULES, SCHEDULE_RULES, botRepliesBody, botRepliesForm, botRepliesIssues, checkFields, costText, count,
  dollarsOf, iconUrl, limitsBody, modelError, money, priceBody, priceLabel, rangeError, scheduleBody, sharePercent, toMicros,
} from "./limits-format";

describe("money conversions", () => {
  test("micro-dollars show as dollars without float noise", () => {
    expect(dollarsOf(300_000)).toBe(0.3);
    expect(dollarsOf(1_500_000)).toBe(1.5);
  });

  test("dollars from a field become micro-dollars, and back", () => {
    expect(toMicros(1.1)).toBe(1_100_000);
    expect(toMicros(1_000_000)).toBe(1_000_000_000_000);
    expect(dollarsOf(toMicros(12.34))).toBe(12.34);
  });

  test("a limit reads with two decimals and a dollar sign", () => {
    expect(money(1_234_567)).toBe("$1.23");
    expect(money(0)).toBe("$0.00");
  });

  test("a price per million tokens keeps two decimals and more only when needed", () => {
    expect(priceLabel(150_000)).toBe("$0.15");
    expect(priceLabel(2_500_000)).toBe("$2.50");
    expect(priceLabel(1_234_567)).toBe("$1.234567");
  });

  test("a table cost has two decimals with separators from the reader's locale", () => {
    expect(costText(2_500_000)).toMatch(/^2[.,]50$/);
    expect(count(1234)).toMatch(/^1\D?234$/);
    expect(count(7)).toBe("7");
  });

  test("a share is a whole percent of the total, capped at 100, and zero with no total", () => {
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(9, 3)).toBe(100);
    expect(sharePercent(5, 0)).toBe(0);
  });

  test("only Discord CDN icons are shown", () => {
    expect(iconUrl("https://cdn.discordapp.com/icons/1/a.png")).toBe("https://cdn.discordapp.com/icons/1/a.png");
    expect(iconUrl("https://evil.example/a.png")).toBeNull();
    expect(iconUrl(null)).toBeNull();
  });
});

describe("range checks", () => {
  test("an empty field is not a number, and bounds are inclusive", () => {
    const rule = { min: 0, max: 1000, whole: true };
    expect(rangeError(Number.NaN, rule)).not.toBeNull();
    expect(rangeError(0, rule)).toBeNull();
    expect(rangeError(1000, rule)).toBeNull();
    expect(rangeError(1001, rule)).not.toBeNull();
    expect(rangeError(-1, rule)).not.toBeNull();
  });

  test("a whole-number field refuses fractions", () => {
    expect(rangeError(2.5, { min: 0, max: 1000, whole: true })).not.toBeNull();
    expect(rangeError(2.5, { min: 0, max: 1000 })).toBeNull();
  });

  test("checkFields names only the fields that are wrong", () => {
    const issues = checkFields({ five: -1, week: 5, grace: 2.5 }, LIMITS_RULES);
    expect(Object.keys(issues).sort()).toEqual(["five", "grace"]);
  });

  test("a model ID is one word of up to 200 characters", () => {
    expect(modelError("  ")).not.toBeNull();
    expect(modelError("gpt 4")).not.toBeNull();
    expect(modelError("a".repeat(201))).not.toBeNull();
    expect(modelError("openai/gpt-x")).toBeNull();
  });
});

describe("usage limits", () => {
  test("dollars become micros, and the grace stays a percent", () => {
    expect(limitsBody({ five: 1.5, week: 0, grace: 10 })).toEqual({ five_hour_cost_micros: 1_500_000, week_cost_micros: 0, grace_percent: 10 });
  });

  test("the largest dollar limit is the bot's largest micro limit", () => {
    expect(limitsBody({ five: 1_000_000, week: 1_000_000, grace: 0 })).toMatchObject({ five_hour_cost_micros: 1e12, week_cost_micros: 1e12 });
    expect(Object.keys(checkFields({ five: 1_000_001, week: 1, grace: 0 }, LIMITS_RULES))).toEqual(["five"]);
  });
});

describe("model prices", () => {
  test("each price converts to micros for the POST", () => {
    expect(priceBody("gpt-x", { input: 2.5, cached_input: 0.25, output: 10 })).toEqual({ model: "gpt-x", input: 2_500_000, cached_input: 250_000, output: 10_000_000 });
  });

  test("a negative price is refused", () => {
    expect(Object.keys(checkFields({ input: -0.1, cached_input: 0, output: 1 }, PRICE_RULES))).toEqual(["input"]);
  });
});

describe("replies to other bots", () => {
  const saved = { replies: 5, minutes: 10 };

  test("without a temporary part the body leaves the current temporary limit alone", () => {
    const form = botRepliesForm(saved);
    expect(botRepliesIssues(form)).toEqual({});
    expect(botRepliesBody(form)).toEqual({ replies: 5, minutes: 10 });
  });

  test("a bad temporary field is checked only when Lasts is filled", () => {
    const form = { ...botRepliesForm(saved), tempReplies: 2000, tempMinutes: 2 };
    expect(botRepliesIssues(form)).toEqual({});
    expect(Object.keys(botRepliesIssues({ ...form, tempFor: 30 }))).toEqual(["tempReplies"]);
  });

  test("a temporary limit sends its length as for_minutes", () => {
    const form = { ...botRepliesForm(saved), tempReplies: 1, tempMinutes: 2, tempFor: 60 };
    expect(botRepliesBody(form)).toEqual({ replies: 5, minutes: 10, temporary: { for_minutes: 60, replies: 1, minutes: 2 } });
  });

  test("the form shows the active temporary limit with an empty Lasts", () => {
    const form = botRepliesForm({ ...saved, temporary: { replies: 1, minutes: 2, until: 0 } });
    expect(form).toMatchObject({ tempReplies: 1, tempMinutes: 2 });
    expect(Number.isNaN(form.tempFor)).toBe(true);
  });
});

describe("scheduled tasks", () => {
  test("the minimum minutes go under one object, as the bot reads them", () => {
    expect(scheduleBody({ perServer: 3, perUser: 2, minMessage: 5, minPrompt: 60, minTool: 120 })).toEqual({
      perServer: 3, perUser: 2, minMinutes: { message: 5, prompt: 60, tool: 120 },
    });
  });

  test("zero is not allowed for any cap or minimum", () => {
    expect(Object.keys(checkFields({ perServer: 0, perUser: 1, minMessage: 1, minPrompt: 1, minTool: 0 }, SCHEDULE_RULES)).sort()).toEqual(["minTool", "perServer"]);
  });
});
