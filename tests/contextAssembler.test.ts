import { describe, it, expect } from "vitest";
import { assembleContext } from "../src/harness/contextAssembler";

describe("assembleContext", () => {
  it("prepends the system prompt and appends the new user input after history", () => {
    const messages = assembleContext({
      systemPrompt: "you are a nutrition advisor",
      history: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
      ],
      userInput: "how much protein in an egg?",
    });

    expect(messages).toEqual([
      { role: "system", content: "you are a nutrition advisor" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "how much protein in an egg?" },
    ]);
  });

  it("works with no prior history", () => {
    const messages = assembleContext({
      systemPrompt: "sys",
      history: [],
      userInput: "hi",
    });

    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });
});
