import type { Db } from "../db";

export async function audit(
  db: Db,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  await db`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
    VALUES (${userId}, ${action}, ${entityType}, ${entityId}, ${details ? db.json(details as never) : null})
  `;
}
