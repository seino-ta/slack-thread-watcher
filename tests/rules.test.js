import { describe, expect, test } from "vitest";
import { looksLikeReplyText } from "../lib/textRules.js";
import { ensureWindowMs, trimTimestamps } from "../lib/floodUtils.js";

describe("looksLikeReplyText", () => {
  test("re: を含むテキストを検知する", () => {
    expect(looksLikeReplyText("re: 了解しました")).toBe(true);
    expect(looksLikeReplyText("Re: ご確認ください")).toBe(true);
    expect(looksLikeReplyText("  RE: テスト ")).toBe(true);
  });

  test("re: 以外は検知しない", () => {
    expect(looksLikeReplyText("返信ありがとう")).toBe(false);
    expect(looksLikeReplyText("reference value")).toBe(false);
    expect(looksLikeReplyText("")).toBe(false);
  });
});

describe("flood utils", () => {
  test("ensureWindowMs は1秒未満を既定値に丸める", () => {
    expect(ensureWindowMs(30)).toBe(30_000);
    expect(ensureWindowMs("45")).toBe(45_000);
    expect(ensureWindowMs(0)).toBe(60_000);
    expect(ensureWindowMs(undefined)).toBe(60_000);
  });

  test("trimTimestamps は指定ウインドウ内の値のみ維持する", () => {
    const timestamps = [1_000, 5_000, 7_000, 8_000];
    const windowMs = 3_000;
    const filtered = trimTimestamps(timestamps, windowMs, 9_000);
    expect(filtered).toEqual([7_000, 8_000]);
  });

  test("trimTimestamps は数値以外を除外する", () => {
    const timestamps = [9_000, "invalid", NaN, 10_000];
    const filtered = trimTimestamps(timestamps, 5_000, 12_000);
    expect(filtered).toEqual([9_000, 10_000]);
  });
});
