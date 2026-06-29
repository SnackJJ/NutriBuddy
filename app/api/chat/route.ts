import { type NextRequest } from "next/server";
import { run } from "@/harness/loop";
import { DeepSeekAdapter } from "@/harness/modelAdapter";
import { Tracer } from "@/harness/tracer";
import { EventLog } from "@/harness/eventLog";
import { createServerSupabase } from "@/lib/supabase";
import {
  createMemoryStore,
  createSupabaseProfileGateway,
} from "@/lib/memoryStore";
import { supabaseInteractionStore } from "@/lib/drugInteractions";
import type { ChatMessage, AgentEvent } from "@/harness/types";
import type { UserContext } from "@/harness/gate";
import type { InteractionStore } from "@/lib/drugInteractions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Expected POST body. */
interface ChatRequestBody {
  readonly message: string;
  readonly history?: readonly ChatMessage[];
  readonly userId?: string;
}

/**
 * Try to load the user's safety context (allergies + medications) from
 * Supabase.  Returns undefined when the DB isn't available or the user
 * has no profile yet — the agent simply runs without the pre/post gate.
 */
async function loadUserContext(
  userId: string,
): Promise<
  { userContext: UserContext; interactionStore: InteractionStore } | undefined
> {
  try {
    const client = createServerSupabase();
    const gateway = createSupabaseProfileGateway(client);
    const store = createMemoryStore({ gateway });
    const profile = await store.getProfile(userId);
    if (
      !profile ||
      (profile.allergies.length === 0 && profile.medications.length === 0)
    ) {
      return undefined;
    }
    return {
      userContext: {
        allergies: profile.allergies,
        medications: profile.medications,
      },
      interactionStore: supabaseInteractionStore(client),
    };
  } catch {
    // DB / table not yet provisioned — proceed without gate
    return undefined;
  }
}

/**
 * POST /api/chat — run the agent loop and stream events back as NDJSON
 * (one JSON object per line).  The client reads the stream progressively
 * to render thought / tool / observe events and the final reply.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { message, history = [], userId } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: "message is required and must be non-empty" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Load safety context before streaming (fail-soft: gate is optional)
  let userContext: UserContext | undefined;
  let interactionStore: InteractionStore | undefined;
  if (userId && typeof userId === "string") {
    const ctx = await loadUserContext(userId);
    if (ctx) {
      userContext = ctx.userContext;
      interactionStore = ctx.interactionStore;
    }
  }

  const adapter = new DeepSeekAdapter();
  const tracer = new Tracer();
  const sessionId = userId ?? "anonymous";
  const eventLog = new EventLog(sessionId);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
      };

      try {
        const gen = run({
          userInput: message,
          adapter,
          tracer,
          eventLog,
          history,
          userContext,
          interactionStore,
          tools: undefined,
        });

        let result = await gen.next();
        while (!result.done) {
          enqueue(result.value as AgentEvent);
          result = await gen.next();
        }

        // Terminal result is the return value of the generator
        enqueue({ type: "terminal", ...result.value });
        controller.close();
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        const safeMessage = errorMessage.includes("DEEPSEEK_API_KEY")
          ? "AI model is not configured yet. Please add DEEPSEEK_API_KEY to your environment."
          : errorMessage;
        enqueue({ type: "error", error: safeMessage });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    },
  });
}
