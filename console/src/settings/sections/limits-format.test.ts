import { describe, expect, test } from "vitest";
import {
  LIMITS_RULES, PRICE_RULES, PROJECT_RULES, SCHEDULE_RULES, botRepliesBody, botRepliesForm, botRepliesIssues, checkFields,
  dollarsOf, iconUrl, limitsBody, megabytesOf, modelError, priceBody, projectsBody, projectsForm, rangeError, scheduleBody, toBytes, toMicros,
} from "./limits-format";

describe("money conversions", () => {
  test("dollars from a field become micro-dollars, and back, without float noise", () => {
    expect(toMicros(1.1)).toBe(1_100_000);
    expect(dollarsOf(toMicros(12.34))).toBe(12.34);
  });

  test("only Discord CDN icons are shown", () => {
    expect(iconUrl("https://cdn.discordapp.com/icons/1/a.png")).toBe("https://cdn.discordapp.com/icons/1/a.png");
    expect(iconUrl("https://evil.example/a.png")).toBeNull();
    expect(iconUrl(null)).toBeNull();
  });
});

describe("range checks", () => {
  test("an empty field is not a number, bounds are inclusive, whole fields refuse fractions", () => {
    const rule = { min: 0, max: 1000, whole: true };
    expect(rangeError(Number.NaN, rule)).not.toBeNull();
    expect(rangeError(0, rule)).toBeNull();
    expect(rangeError(1000, rule)).toBeNull();
    expect(rangeError(1001, rule)).not.toBeNull();
    expect(rangeError(-1, rule)).not.toBeNull();
    expect(rangeError(2.5, rule)).not.toBeNull();
  });

  test("checkFields names only the fields that are wrong", () => {
    const issues = checkFields({ five: -1, week: 5, grace: 2.5 }, LIMITS_RULES);
    expect(Object.keys(issues).sort()).toEqual(["five", "grace"]);
  });

  test("a model ID is one word of up to 200 characters", () => {
    for (const bad of ["  ", "gpt 4", "a".repeat(201)]) expect(modelError(bad)).not.toBeNull();
    expect(modelError("openai/gpt-x")).toBeNull();
  });
});

describe("usage limits", () => {
  test("the largest dollar limit is the bot's largest micro limit", () => {
    expect(limitsBody({ five: 1_000_000, week: 1_000_000, grace: 0 })).toMatchObject({ five_hour_cost_micros: 1e12, week_cost_micros: 1e12 });
    expect(Object.keys(checkFields({ five: 1_000_001, week: 1, grace: 0 }, LIMITS_RULES))).toEqual(["five"]);
  });
});

describe("model prices", () => {
  test("each price converts to micros for the POST, and a negative price is refused", () => {
    expect(priceBody("gpt-x", { input: 2.5, cached_input: 0.25, output: 10 })).toEqual({ model: "gpt-x", input: 2_500_000, cached_input: 250_000, output: 10_000_000 });
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

describe("projects", () => {
  test("megabytes from a field become bytes, and back, for every size the bot allows", () => {
    for (const bytes of [1024, 2 * 1024 * 1024, 10 * 1024 * 1024, 200 * 1024 * 1024, 2 * 1024 ** 3]) {
      expect(toBytes(megabytesOf(bytes))).toBe(bytes);
    }
    expect(megabytesOf(10 * 1024 * 1024)).toBe(10);
    expect(toBytes(2.5)).toBe(2_621_440);
  });

  test("the form shows megabytes and the body sends bytes", () => {
    const form = projectsForm({ maxProjects: 20, maxFiles: 50, maxFileBytes: 10 * 1024 * 1024, maxProjectBytes: 200 * 1024 * 1024 });
    expect(form).toEqual({ projects: 20, files: 50, fileMb: 10, projectMb: 200 });
    expect(projectsBody({ ...form, fileMb: 2.5 })).toEqual({ maxProjects: 20, maxFiles: 50, maxFileBytes: 2_621_440, maxProjectBytes: 200 * 1024 * 1024 });
  });

  test("the smallest file (1 KiB) is allowed, and zero projects, a file over 10 MB or a project over 2048 MB are not", () => {
    expect(checkFields({ projects: 1, files: 1, fileMb: 1 / 1024, projectMb: 1 }, PROJECT_RULES)).toEqual({});
    expect(Object.keys(checkFields({ projects: 0, files: 50, fileMb: 10.5, projectMb: 2049 }, PROJECT_RULES)).sort()).toEqual(["fileMb", "projectMb", "projects"]);
  });
});
