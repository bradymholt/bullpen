import { randomUUID } from "node:crypto";
import { db } from "./db/index.ts";
import { agents } from "./db/schema.ts";

/** Step 2 only: one agent to exercise the run loop before CRUD exists. */
export function seedScratchAgent(): void {
  const existing = db.select({ id: agents.id }).from(agents).limit(1).get();
  if (existing) return;

  db.insert(agents)
    .values({
      id: randomUUID(),
      name: "Scratch",
      description: "Throwaway agent for exercising the run loop.",
      prompt: "Say hello, then create a file called hello.txt containing a haiku about bullpens.",
      permissionMode: "supervised",
      workspaceKind: "scratch",
      workspaceConfig: { kind: "scratch" },
    })
    .run();
}
