import { type NextRequest } from "next/server";
import { createUserSupabase } from "@/lib/supabase";
import { assertSessionSubject, getSessionFromHeader } from "@/lib/auth";
import {
  createMemoryStore,
  createSupabaseProfileGateway,
} from "@/lib/memoryStore";
import {
  loadConfiguredCatalog,
  createInMemoryQueryRunner,
  createQueryCatalog,
  ALL_QUERY_TEMPLATES,
} from "@/catalog";
import { listUserMealRecords } from "@/lib/mealLogStore";
import { createSupabaseQueryRunner } from "@/lib/sqlQueryRunner";
import {
  computeRemaining,
  emptyTotals,
  todayDateString,
} from "@/lib/todayTotals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const catalog = loadConfiguredCatalog();
const queryCatalog = createQueryCatalog(ALL_QUERY_TEMPLATES);

/**
 * GET /api/today — consumed macros (daily_totals) + profile targets + remaining.
 * No free-form SQL; remaining is app-layer arithmetic (RFC 0004 §5).
 */
export async function GET(request: NextRequest): Promise<Response> {
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

  const userClient = createUserSupabase(session.accessToken);
  const date = todayDateString();

  const queryRunner =
    process.env.NUTRIBUDDY_QUERY_RUNNER === "sql"
      ? createSupabaseQueryRunner(userClient, catalog)
      : createInMemoryQueryRunner(
          catalog,
          await listUserMealRecords(userClient, session.userId).catch(() => []),
        );

  if (!queryCatalog.templates.has("daily_totals")) {
    return new Response(JSON.stringify({ error: "daily_totals missing" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let consumed = emptyTotals();
  let mealCount = 0;
  try {
    const obs = await queryRunner(
      "daily_totals",
      { date_from: date, date_to: date },
      session.userId,
    );
    const row = obs.rows[0] as
      | {
          total_kcal?: number;
          total_protein_g?: number;
          total_fat_g?: number;
          total_carbs_g?: number;
          meal_count?: number;
        }
      | undefined;
    if (row) {
      consumed = {
        kcal: Number(row.total_kcal ?? 0),
        proteinG: Number(row.total_protein_g ?? 0),
        fatG: Number(row.total_fat_g ?? 0),
        carbsG: Number(row.total_carbs_g ?? 0),
      };
      mealCount = Number(row.meal_count ?? 0);
    }
  } catch (err) {
    console.error("[today] daily_totals failed", err);
    return new Response(
      JSON.stringify({ error: "daily_totals_unavailable", date }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const store = createMemoryStore({
    gateway: createSupabaseProfileGateway(userClient),
  });
  const profile = await store.getProfile(session.userId).catch(() => null);
  const targets = {
    kcalTarget: profile?.kcalTarget ?? null,
    proteinTargetG: profile?.proteinTargetG ?? null,
    fatTargetG: profile?.fatTargetG ?? null,
    carbsTargetG: profile?.carbsTargetG ?? null,
  };
  const remaining = computeRemaining(consumed, targets);

  return new Response(
    JSON.stringify({
      date,
      consumed,
      targets,
      remaining,
      mealCount,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
