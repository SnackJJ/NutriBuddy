// ⑦ Tracer（事件溯源持久日志，issue #5 / PRD §10）。
//
// 不可变、仅追加的事件流：agent 每次交互的每一步以结构化 JSONL 落盘，
// traces/{sessionId}.jsonl 一个 session 一个文件。格式为「一行一事件」，
// 刻意保持自描述（id/timestamp/type/data），便于未来 NutriMind RL 训练直接消费。
//
// 与 issue #1 的内存版 turn Tracer（tracer.ts，step/payload/render）是两层关注点：
// 那层服务 CLI 实时渲染；本层服务持久、可重放、可训练的事件溯源。后续切片由
// loop / post-gate 把规范事件喂进来（见文件末尾 next-step）。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 规范事件类型（OpenHands 事件溯源词表）。覆盖一次 turn 的全部可观测节点：
 * - model_call     ：发起一次模型调用（prompt / 旋钮）
 * - tool_call      ：发起一次工具调用（工具名 + 完整 args/context）
 * - tool_result    ：工具返回
 * - user_message   ：用户输入
 * - agent_response ：agent 最终答复
 * - error          ：异常 / 撞上限 / 解析失败
 * - gate_block     ：post-gate 硬拦（ADR 0001 的确定性后置闸）
 */
export type LogEventType =
  | "model_call"
  | "tool_call"
  | "tool_result"
  | "user_message"
  | "agent_response"
  | "error"
  | "gate_block";

/** 落盘的一条事件。不可变，自描述。 */
export interface LogEvent {
  /** 进程内单调 id，关联同一 session 内的事件。 */
  readonly id: string;
  /** 事件发生时刻，ISO 8601。 */
  readonly timestamp: string;
  readonly type: LogEventType;
  /** 事件载荷：工具调用塞完整 context，gate_block 塞拦截原因，等等。 */
  readonly data: Readonly<Record<string, unknown>>;
}

/** record 的入参：id/timestamp 由 Tracer 合成，调用方只给 type + data。 */
export interface LogEventInput {
  readonly type: LogEventType;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * 可注入依赖（沿 harness 既有 DI 约定）：默认走真实 fs / 系统时钟 / 计数 id，
 * 单测注入内存 sink + 固定时钟，保持纯净确定。
 */
export interface EventLogDeps {
  /** traces 根目录，默认 "traces"。 */
  readonly dir?: string;
  /** 时钟，默认 () => new Date()。 */
  readonly now?: () => Date;
  /** id 工厂，默认本 session 内单调计数。 */
  readonly nextId?: () => string;
  /** 追加写一行，默认 fs 同步 append（先 mkdir -p）。 */
  readonly append?: (filePath: string, line: string) => void;
}

// session_id 直接拼进文件路径，必须挡住路径穿越 / 子目录逃逸：只放行不含分隔符、
// 不为「.」「..」、非空的安全名。
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    !SAFE_SESSION_ID.test(sessionId)
  ) {
    throw new Error(
      `unsafe session id: ${JSON.stringify(sessionId)} — 仅允许 [A-Za-z0-9._-]，禁止路径分隔符`,
    );
  }
}

function defaultAppend(filePath: string, line: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, line, "utf8");
}

export class EventLog {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly nextId: () => string;
  private readonly append: (filePath: string, line: string) => void;

  constructor(sessionId: string, deps: EventLogDeps = {}) {
    assertSafeSessionId(sessionId);
    const dir = deps.dir ?? "traces";
    this.filePath = join(dir, `${sessionId}.jsonl`);
    this.now = deps.now ?? (() => new Date());
    this.append = deps.append ?? defaultAppend;

    let counter = 0;
    this.nextId = deps.nextId ?? (() => `${sessionId}-${counter++}`);
  }

  /** 合成完整事件、追加一行 JSON、返回落盘的事件供调用方关联。 */
  record(input: LogEventInput): LogEvent {
    const event: LogEvent = {
      id: this.nextId(),
      timestamp: this.now().toISOString(),
      type: input.type,
      data: input.data ?? {},
    };
    this.append(this.filePath, JSON.stringify(event) + "\n");
    return event;
  }

  /** 本 session 的 JSONL 文件路径。 */
  path(): string {
    return this.filePath;
  }
}

// 下一步（后续切片，非本 issue）：post-gate 切片在硬拦处
// record({ type: "gate_block", ... })；工具切片在 tool_call/tool_result 时喂事件；
// 可加 EventLog.read() 重放器。
