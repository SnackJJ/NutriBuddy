import { describe, it, expect } from "vitest";
import { EventLog, type LogEvent } from "../src/harness/eventLog";
import { memSink, fixedDeps } from "./helpers/eventLog";

describe("EventLog", () => {
  it("appends one JSON line per event to traces/{sessionId}.jsonl, with id/timestamp/type/data", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("sess-abc", deps);

    log.record({ type: "user_message", data: { text: "hi" } });

    expect(sink.writes).toHaveLength(1);
    const { path, line } = sink.writes[0];
    expect(path).toBe("traces/sess-abc.jsonl");
    expect(line.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(line) as LogEvent;
    expect(parsed).toEqual({
      id: "evt_0",
      timestamp: "2026-06-26T00:00:00.000Z",
      type: "user_message",
      data: { text: "hi" },
    });
  });

  it("appends sequentially to one file per session", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("s1", deps);

    log.record({ type: "user_message", data: { text: "q" } });
    log.record({ type: "agent_response", data: { text: "a" } });

    expect(sink.writes.map((w) => w.path)).toEqual([
      "traces/s1.jsonl",
      "traces/s1.jsonl",
    ]);
    expect(sink.writes.map((w) => JSON.parse(w.line).type)).toEqual([
      "user_message",
      "agent_response",
    ]);
    expect(sink.writes.map((w) => JSON.parse(w.line).id)).toEqual([
      "evt_0",
      "evt_1",
    ]);
  });

  it("records full tool-call context verbatim in data", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("s2", deps);
    const context = {
      tool: "search_food",
      args: { query: "banana", limit: 5 },
      messages: [{ role: "user", content: "卡路里?" }],
    };

    log.record({ type: "tool_call", data: context });

    const parsed = JSON.parse(sink.writes[0].line) as LogEvent;
    expect(parsed.type).toBe("tool_call");
    expect(parsed.data).toEqual(context);
  });

  it("records gate_block events for post-gate hard blocks", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("s3", deps);

    log.record({ type: "gate_block", data: { reason: "unsafe_dose", rule: "ul_check" } });

    const parsed = JSON.parse(sink.writes[0].line) as LogEvent;
    expect(parsed.type).toBe("gate_block");
    expect(parsed.data).toEqual({ reason: "unsafe_dose", rule: "ul_check" });
  });

  it("defaults data to empty object when omitted", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("s4", deps);

    log.record({ type: "error" });

    const parsed = JSON.parse(sink.writes[0].line) as LogEvent;
    expect(parsed.data).toEqual({});
  });

  it("rejects session IDs that would escape traces/ (path traversal protection)", () => {
    const { deps } = fixedDeps();
    expect(() => new EventLog("../etc/passwd", deps)).toThrow(/session/i);
    expect(() => new EventLog("a/b", deps)).toThrow(/session/i);
    expect(() => new EventLog("", deps)).toThrow(/session/i);
  });

  it("returns the recorded event from record() for caller correlation", () => {
    const { deps } = fixedDeps();
    const log = new EventLog("s5", deps);

    const event = log.record({ type: "model_call", data: { tier: "flash" } });
    expect(event.id).toBe("evt_0");
    expect(event.type).toBe("model_call");
    expect(event.timestamp).toBe("2026-06-26T00:00:00.000Z");
  });
});
