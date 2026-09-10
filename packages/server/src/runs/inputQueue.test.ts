import { describe, expect, it } from "vitest";
import { InputQueue } from "./inputQueue.ts";

async function drain(q: InputQueue): Promise<string[]> {
  const out: string[] = [];
  for await (const m of q) out.push(m.message.content as string);
  return out;
}

describe("InputQueue", () => {
  it("yields messages pushed before iteration starts", async () => {
    const q = new InputQueue();
    q.push("one");
    q.push("two");
    q.close();
    expect(await drain(q)).toEqual(["one", "two"]);
  });

  it("stays open for messages pushed while the consumer waits", async () => {
    const q = new InputQueue();
    q.push("first");
    const collected = drain(q);
    await new Promise((r) => setTimeout(r, 10));
    q.push("second");
    await new Promise((r) => setTimeout(r, 10));
    q.close();
    expect(await collected).toEqual(["first", "second"]);
  });

  it("shapes messages the way the SDK expects", async () => {
    const q = new InputQueue();
    q.push("hello");
    q.close();
    for await (const m of q) {
      expect(m.type).toBe("user");
      expect(m.parent_tool_use_id).toBeNull();
      expect(m.message).toEqual({ role: "user", content: "hello" });
    }
  });

  it("refuses pushes after close so a stopped run cannot be fed", () => {
    const q = new InputQueue();
    q.close();
    expect(() => q.push("late")).toThrow(/closed/);
  });
});
