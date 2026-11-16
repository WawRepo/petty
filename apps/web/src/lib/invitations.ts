import { DrawerInvitation, z } from "@petty/protocol";
import { api } from "./api.js";

const List = z.object({ invitations: z.array(DrawerInvitation) });

/**
 * PETTY-498: the drawer's pending invitations, whoever of its owners made them (PETTY-446). Only the
 * owner may ask: the server answers 403 to a member, so the caller asks only when this person owns it.
 */
export async function drawerInvitations(drawerId: string): Promise<DrawerInvitation[]> {
  return List.parse(await api<unknown>("GET", `/drawers/${encodeURIComponent(drawerId)}/invitations`)).invitations;
}

/** PETTY-498: the owner withdraws a pending invitation; the invitee can no longer accept it. */
export async function withdrawInvitation(invitationId: string): Promise<void> {
  await api("DELETE", `/invitations/${encodeURIComponent(invitationId)}`);
}
