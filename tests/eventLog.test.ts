import { describe, it, expect } from "vitest";
import { EventLog, type TraceEvent } from "../src/harness/eventLog";

// 一个内存版 append sink：把每次写入的 (path, line) 收下来，供断言 JSONL 行内容，
// 不碰真实文件系统（保持单测纯净、确定）。
function memSink() {
  const writes: { path: string; line: string }[] = [];
  return {
    writes,
    append: (path: string, line: string) => writes.push({ path, line }),
  };
}

// 固定时钟 + 计数 id，确定性可断言。
function fixedDeps(sink = memSink()) {
  let n = 0;
  return {
    sink,
    deps: {
      append: sink.append,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
      nextId: () => `evt_${n++}`,
    },
  };
}

describe("EventLog（事件溯源持久日志）", () => {
  it("每条事件追加一行 JSON 到 traces/{sessionId}.jsonl，含 id/timestamp/type/data", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("sess-abc", deps);

    log.record({ type: "user_message", data: { text: "hi" } });

    expect(sink.writes).toHaveLength(1);
    const { path, line } = sink.writes[0];
    expect(path).toBe("traces/sess-abc.jsonl");
    expect(line.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(line) as TraceEvent;
    expect(parsed).toEqual({
      id: "evt_0",
      timestamp: "2026-06-26T00:00:00.000Z",
      type: "user_message",
      data: { text: "hi" },
    });
  });

  it("仅追加、按序写多行；每个 session 一个文件", () => {
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

  it("工具调用记录完整 context（data 原样落盘）", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("s2", deps);
    const context = {
      tool: "search_food",
      args: { query: "banana", limit: 5 },
      messages: [{ role: "user", content: "卡路里?" }],
    };

    log.record({ type: "tool_call", data: context });

    const parsed = JSON.parse(sink.writes[0].line) as TraceEvent;
    expect(parsed.type).toBe("tool_call");
    expect(parsed.data).toEqual(context);
  });

  it("post-gate 硬拦记录 gate_block 事件", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("s3", deps);

    log.record({ type: "gate_block", data: { reason: "unsafe_dose", rule: "ul_check" } });

    const parsed = JSON.parse(sink.writes[0].line) as TraceEvent;
    expect(parsed.type).toBe("gate_block");
    expect(parsed.data).toEqual({ reason: "unsafe_dose", rule: "ul_check" });
  });

  it("data 省略时落空对象，不写 undefined", () => {
    const { sink, deps } = fixedDeps();
    const log = new EventLog("s4", deps);

    log.record({ type: "error" });

    const parsed = JSON.parse(sink.writes[0].line) as TraceEvent;
    expect(parsed.data).toEqual({});
  });

  it("拒绝会越权写出 traces/ 之外的 session_id（路径穿越防护）", () => {
    const { deps } = fixedDeps();
    expect(() => new EventLog("../etc/passwd", deps)).toThrow(/session/i);
    expect(() => new EventLog("a/b", deps)).toThrow(/session/i);
    expect(() => new EventLog("", deps)).toThrow(/session/i);
  });

  it("record 返回落盘的完整事件，供调用方关联", () => {
    const { deps } = fixedDeps();
    const log = new EventLog("s5", deps);

    const event = log.record({ type: "model_call", data: { tier: "flash" } });
    expect(event.id).toBe("evt_0");
    expect(event.type).toBe("model_call");
    expect(event.timestamp).toBe("2026-06-26T00:00:00.000Z");
  });
});
