import { describe, expect, it } from "vitest";
import { matchCondition, type Condition, type Operator } from "../src/index.js";

const c = (operator: Operator, value: Condition["value"], attribute = "a"): Condition => ({ attribute, operator, value });
const m = (cond: Condition, attrs: Record<string, any> | undefined) => matchCondition(cond, attrs);

describe("equals / not_equals", () => {
  it("compares strictly with no type coercion", () => {
    expect(m(c("equals", "pro"), { a: "pro" })).toBe(true);
    expect(m(c("equals", "pro"), { a: "free" })).toBe(false);
    expect(m(c("equals", 5), { a: 5 })).toBe(true);
    expect(m(c("equals", 5), { a: "5" })).toBe(false);
    expect(m(c("equals", true), { a: true })).toBe(true);
    expect(m(c("equals", true), { a: "true" })).toBe(false);
  });

  it("treats an array attribute as any-element for equals and none-element for not_equals", () => {
    expect(m(c("equals", "beta"), { a: ["alpha", "beta"] })).toBe(true);
    expect(m(c("not_equals", "beta"), { a: ["alpha", "beta"] })).toBe(false);
    expect(m(c("not_equals", "gamma"), { a: ["alpha", "beta"] })).toBe(true);
  });

  it("not_equals matches a different present value", () => {
    expect(m(c("not_equals", "pro"), { a: "free" })).toBe(true);
    expect(m(c("not_equals", "pro"), { a: "pro" })).toBe(false);
  });

  it("never matches when given a list value", () => {
    expect(m(c("equals", ["a"]), { a: "a" })).toBe(false);
    expect(m(c("not_equals", ["a"]), { a: "b" })).toBe(false);
  });
});

describe("in / not_in", () => {
  it("checks membership in the list", () => {
    expect(m(c("in", ["US", "CA"]), { a: "US" })).toBe(true);
    expect(m(c("in", ["US", "CA"]), { a: "DE" })).toBe(false);
    expect(m(c("not_in", ["US", "CA"]), { a: "DE" })).toBe(true);
    expect(m(c("not_in", ["US", "CA"]), { a: "US" })).toBe(false);
    expect(m(c("in", [1, 2, 3]), { a: 2 })).toBe(true);
    expect(m(c("in", [1, 2, 3]), { a: "2" })).toBe(false);
  });

  it("matches an array attribute when any element is in the list", () => {
    expect(m(c("in", ["admin"]), { a: ["user", "admin"] })).toBe(true);
    expect(m(c("not_in", ["admin"]), { a: ["user", "admin"] })).toBe(false);
  });

  it("requires a list value", () => {
    expect(m(c("in", "US"), { a: "US" })).toBe(false);
    expect(m(c("not_in", "US"), { a: "DE" })).toBe(false);
  });
});

describe("string operators", () => {
  it("contains, starts_with, ends_with on strings", () => {
    expect(m(c("contains", "@acme"), { a: "ada@acme.com" })).toBe(true);
    expect(m(c("contains", "@acme"), { a: "ada@other.com" })).toBe(false);
    expect(m(c("starts_with", "ada"), { a: "ada@acme.com" })).toBe(true);
    expect(m(c("ends_with", ".com"), { a: "ada@acme.com" })).toBe(true);
    expect(m(c("ends_with", ".org"), { a: "ada@acme.com" })).toBe(false);
  });

  it("contains works on an array attribute", () => {
    expect(m(c("contains", "beta"), { a: ["alpha", "beta"] })).toBe(true);
    expect(m(c("contains", "bet"), { a: ["alpha", "beta"] })).toBe(false);
  });

  it("does not match non-strings", () => {
    expect(m(c("contains", "1"), { a: 1 })).toBe(false);
    expect(m(c("starts_with", "t"), { a: true })).toBe(false);
    expect(m(c("ends_with", "1"), { a: 11 })).toBe(false);
    expect(m(c("contains", 1), { a: "1" })).toBe(false);
  });
});

describe("numeric operators", () => {
  it("gt, gte, lt, lte", () => {
    expect(m(c("gt", 18), { a: 19 })).toBe(true);
    expect(m(c("gt", 18), { a: 18 })).toBe(false);
    expect(m(c("gte", 18), { a: 18 })).toBe(true);
    expect(m(c("lt", 18), { a: 17 })).toBe(true);
    expect(m(c("lt", 18), { a: 18 })).toBe(false);
    expect(m(c("lte", 18), { a: 18 })).toBe(true);
    expect(m(c("gt", 0), { a: -1 })).toBe(false);
    expect(m(c("lt", 0), { a: -1 })).toBe(true);
  });

  it("never matches strings or mismatched types", () => {
    expect(m(c("gt", 18), { a: "99" })).toBe(false);
    expect(m(c("gt", "18"), { a: 99 })).toBe(false);
    expect(m(c("lt", 18), { a: true })).toBe(false);
  });
});

describe("missing attributes", () => {
  it("never match, for every operator, including the negative ones", () => {
    const cases: Condition[] = [
      c("equals", "x"),
      c("not_equals", "x"),
      c("in", ["x"]),
      c("not_in", ["x"]),
      c("contains", "x"),
      c("starts_with", "x"),
      c("ends_with", "x"),
      c("gt", 1),
      c("gte", 1),
      c("lt", 1),
      c("lte", 1),
    ];
    for (const cond of cases) {
      expect(m(cond, {}), cond.operator).toBe(false);
      expect(m(cond, undefined), cond.operator).toBe(false);
      expect(m(cond, { other: "x" }), cond.operator).toBe(false);
      expect(m(cond, { a: undefined }), cond.operator).toBe(false);
    }
  });

  it("does match falsy-but-present values", () => {
    expect(m(c("equals", 0), { a: 0 })).toBe(true);
    expect(m(c("equals", false), { a: false })).toBe(true);
    expect(m(c("equals", ""), { a: "" })).toBe(true);
  });
});

it("ignores inherited object properties such as constructor and __proto__", () => {
  expect(m(c("not_equals", "x", "constructor"), {})).toBe(false);
  expect(m(c("not_in", ["x"], "toString"), {})).toBe(false);
  expect(m(c("equals", "x", "__proto__"), {})).toBe(false);
  expect(m(c("equals", "x", "constructor"), { constructor: "x" } as any)).toBe(true); // an own property is fine
});

it("fails closed on an unknown operator", () => {
  expect(m({ attribute: "a", operator: "regex" as Operator, value: ".*" }, { a: "x" })).toBe(false);
});
