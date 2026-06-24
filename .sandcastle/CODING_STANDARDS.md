# Coding Standards

reviewer agent 在 code review 阶段通过 `@.sandcastle/CODING_STANDARDS.md` 加载本文件，
因此这些规范只在 review 时生效，不消耗 implement 阶段的 token。

## Style

- TypeScript 全程开启 `strict`；禁止 `any`，必要时用 `unknown` + 收窄。
- 变量/函数用 camelCase，类型/组件用 PascalCase，常量用 UPPER_SNAKE_CASE。
- 优先具名导出（named export），少用 default export。
- 优先 `const`，避免可变；用早返回（early return）替代深层嵌套。
- 不要写描述显而易见代码的注释；注释解释「为什么」，不解释「是什么」。

## Testing

- 用 Vitest。每个对外暴露的函数至少一个测试。
- 测试名描述期望行为（`it("rejects empty intake log", ...)`），不写 `it("works")`。
- 优先测公共行为与边界，不测实现细节。

## Architecture

- 遵循 PRD 八模块边界：Loop / ContextAssembler / ToolRegistry / MemoryStore /
  Retriever / Verifier / Tracer / ModelAdapter，模块单一职责，不互相越界。
- 自建 harness 机械，库只填管线——不引入 LangGraph/CrewAI 等编排框架。
- 组合优于继承；模块对外接口要窄而深。
