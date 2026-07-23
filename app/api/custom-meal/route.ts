import { type NextRequest } from "next/server";
import { createUserSupabase } from "@/lib/supabase";
import { assertSessionSubject, getSessionFromHeader } from "@/lib/auth";
import { createSupabaseProposalStore } from "@/lib/proposalStore";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/custom-meal — packaging / hand-entry escape hatch (RFC 0005 §4).
 * Model does not participate; macros come from the user (label).
 * Stores a write proposal for confirm — same lifecycle as log_meal.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionFromHeader(createUserSupabase, request);
  if (!session) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    assertSessionSubject(session);
  } catch {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const foodName = body.foodName;
  const portionG = body.portionG;
  const mealType = body.mealType ?? "snack";
  const kcal = body.kcal;
  const proteinG = body.proteinG;
  const fatG = body.fatG;
  const carbsG = body.carbsG;

  if (typeof foodName !== "string" || foodName.trim().length === 0) {
    return new Response(JSON.stringify({ error: "foodName required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  for (const [k, v] of [
    ["portionG", portionG],
    ["kcal", kcal],
    ["proteinG", proteinG],
    ["fatG", fatG],
    ["carbsG", carbsG],
  ] as const) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return new Response(JSON.stringify({ error: `${k} must be a number ≥ 0` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  if ((portionG as number) <= 0) {
    return new Response(JSON.stringify({ error: "portionG must be > 0" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userClient = createUserSupabase(session.accessToken);
  const store = createSupabaseProposalStore({ client: userClient });
  const id = `custom:hand:${randomUUID()}`;

  // Scale hand-entry (entered as amounts for this portion) is already absolute
  // for the portion — store as-is for the proposal.
  const proposal = await store.store({
    userId: session.userId,
    foodId: id,
    foodName: foodName.trim(),
    canonicalName: foodName.trim(),
    portionG: portionG as number,
    mealType: String(mealType),
    kcal: kcal as number,
    proteinG: proteinG as number,
    fatG: fatG as number,
    carbsG: carbsG as number,
    nutritionSource: `user-hand-entry:${session.userId}`,
    matchType: "exact",
    allergenTags: [],
    allergenCoverage: "unreviewed",
  });

  return new Response(
    JSON.stringify({
      proposal: {
        proposalId: proposal.id,
        foodId: proposal.foodId,
        foodName: proposal.foodName,
        canonicalName: proposal.canonicalName,
        portionG: proposal.portionG,
        mealType: proposal.mealType,
        kcal: proposal.kcal,
        proteinG: proposal.proteinG,
        fatG: proposal.fatG,
        carbsG: proposal.carbsG,
        nutritionSource: proposal.nutritionSource,
        matchType: proposal.matchType,
        allergenTags: proposal.allergenTags,
        allergenCoverage: proposal.allergenCoverage ?? "unreviewed",
        createdAt: proposal.createdAt,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
