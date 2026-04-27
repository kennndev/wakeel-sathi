import "server-only";
import { getSupabaseAdmin } from "../db/supabase-admin";

type WriteActivityLogInput = {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | null;
};

export async function writeActivityLog(input: WriteActivityLogInput): Promise<void> {
  const { error } = await getSupabaseAdmin().from("activity_log").insert({
    organization_id: input.organizationId ?? null,
    actor_user_id: input.actorUserId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    metadata_json: input.metadata ?? null,
  });

  if (error) {
    console.error("activity_log_insert_failed", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
    });
  }
}
