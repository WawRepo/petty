import type { AnyRole } from "@petty/protocol";
import { forbidden, notFound } from "./errors.js";
import type { Queryable } from "./tx.js";

export interface DrawerRow {
  id: string; owner_id: string; version: number; key_version: number;
  last_write_at: Date; last_verified_at: Date | null; rotation_needed: boolean;
}

/** The caller's role on a drawer, or null. A non-member learns nothing (404), never 403. */
export async function roleFor(db: Queryable, drawerId: string, userId: string): Promise<{ role: AnyRole; drawer: DrawerRow } | null> {
  const { rows } = await db.query<DrawerRow & { member_role: "write" | "read" | null }>(
    `select d.*, m.role as member_role from drawers d
       left join drawer_members m on m.drawer_id = d.id and m.user_id = $2
      where d.id = $1`,
    [drawerId, userId],
  );
  const d = rows[0];
  if (!d) return null;
  if (d.owner_id === userId) return { role: "owner", drawer: d };
  if (d.member_role) return { role: d.member_role, drawer: d };
  return null;
}

const RANK: Record<AnyRole, number> = { read: 0, write: 1, owner: 2 };

/** 404 when not a member at all; 403 when the role is too low. */
export async function requireRole(db: Queryable, drawerId: string, userId: string, min: AnyRole): Promise<{ role: AnyRole; drawer: DrawerRow }> {
  const r = await roleFor(db, drawerId, userId);
  if (!r) throw notFound("DrawerNotFound", { drawer_id: drawerId });
  if (RANK[r.role] < RANK[min]) throw forbidden("InsufficientRole", { drawer_id: drawerId, role: r.role, required: min });
  return r;
}
