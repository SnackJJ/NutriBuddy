// Provider faults at the eval boundary (S2 follow-up / #129).
//
// The live baseline hit a 429 mid-run and the case was scored as a capability
// failure: one bad minute at the provider, read as a regression. These tests pin
// both halves of the fix — retry what is transient, and label what survives it —
// plus the half that matters as much: do **not** retry a configuration error,
// because three identical failures cost three times as much and say the same
// thing.

import { describe, expect, it, vi } from "vitest";
import {
  isTransientProviderError,
  withTransientRetry,
} from "../src/eval/providerRetry";

describe("isTransientProviderError", () => {
  it("recognises the faults a second attempt can survive", () => {
    for (const message of [
      'commandcode 请求失败 (429): {"error":{"message":"Upstream model provider is temporarily unavailable"}}',
      "DeepSeek 请求失败 (503): service unavailable",
      "request timed out after 5000ms",
      "socket hang up",
      "ECONNRESET",
      "rate limit exceeded",
      "upstream overloaded",
    ]) {
      expect(isTransientProviderError(message), message).toBe(true);
    }
  });

  it("does not treat a configuration error as transient", () => {
    for (const message of [
      "缺少 COMMANDCODE_API_KEY：请在环境变量中配置模型密钥。",
      "unknown model \"deepseek-v9\"",
      "400 bad request: messages[0].role must be one of",
      "401 invalid api key",
    ]) {
      expect(isTransientProviderError(message), message).toBe(false);
    }
  });
});

describe("withTransientRetry", () => {
  const neverSleep = async () => {};

  it("returns the first healthy value without sleeping", async () => {
    const attempt = vi.fn(async () => "ok");
    const outcome = await withTransientRetry(attempt, () => undefined, {
      attempts: 3,
      sleep: neverSleep,
    });

    expect(outcome).toEqual({ value: "ok", attempts: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries a transient fault and reports how many attempts it took", async () => {
    let call = 0;
    const outcome = await withTransientRetry(
      async () => {
        call += 1;
        return call < 3 ? "FAIL: 429 too many requests" : "ok";
      },
      (value) => (value.includes("429") ? value : undefined),
      { attempts: 3, sleep: neverSleep },
    );

    expect(outcome.value).toBe("ok");
    expect(outcome.attempts).toBe(3);
    expect(outcome.transientFailure).toBeUndefined();
  });

  it("labels a fault that survives every attempt instead of inventing a result", async () => {
    const outcome = await withTransientRetry(
      async () => "FAIL: 503 upstream unavailable",
      (value) => (value.includes("503") ? value : undefined),
      { attempts: 2, sleep: neverSleep },
    );

    expect(outcome.value).toBe("FAIL: 503 upstream unavailable");
    expect(outcome.attempts).toBe(2);
    expect(outcome.transientFailure).toContain("503");
  });

  it("does not retry when the caller says the failure is not transient", async () => {
    const attempt = vi.fn(async () => "FAIL: missing api key");
    const outcome = await withTransientRetry(attempt, () => undefined, {
      attempts: 3,
      sleep: neverSleep,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome.transientFailure).toBeUndefined();
  });

  it("reports each retry so a run can narrate its own flakiness", async () => {
    const retries: number[] = [];
    await withTransientRetry(
      async () => "FAIL: timeout",
      (value) => value,
      { attempts: 3, sleep: neverSleep, onRetry: (info) => retries.push(info.attempt) },
    );
    expect(retries).toEqual([1, 2]);
  });
});
