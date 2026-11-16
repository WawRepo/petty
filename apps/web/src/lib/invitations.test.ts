import { beforeEach, describe, expect, it, vi } from "vitest";

/** PETTY-498: the owner's list of a drawer's pending invitations, and withdrawing one. Only the server is a stand-in. */
const calls: { method: string; path: string }[] = [];
const answer: { current: unknown } = { current: undefined };
vi.mock("./api.js", () => ({
  api: vi.fn(async (method: string, path: string) => {
    calls.push({ method, path });
    return answer.current;
  }),
}));
const { drawerInvitations, withdrawInvitation } = await import("./invitations.js");

const drawer = "6f1d0f43-8a49-4d6c-9a5e-3f1f2f6b9c01";
const row = {
  id: "0b6f3f8e-3a1c-4f55-8a77-1d2e3f4a5b6c",
  drawer_id: drawer,
  role: "read",
  key_version: 2,
  created_at: "2026-11-16T10:00:00.000Z",
  inviter_id: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  invitee: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", display_name: "Cara" },
};

beforeEach(() => { calls.length = 0; answer.current = undefined; });

describe("a drawer's pending invitations (PETTY-498)", () => {
  it("asks the drawer's own route and gives back the rows as the server sent them", async () => {
    answer.current = { invitations: [row] };
    expect(await drawerInvitations(drawer)).toEqual([row]);
    expect(calls).toEqual([{ method: "GET", path: `/drawers/${drawer}/invitations` }]);
  });

  it("refuses an answer that does not have the expected shape", async () => {
    answer.current = { invitations: [{ ...row, role: "owner" }] };
    await expect(drawerInvitations(drawer)).rejects.toThrow();
    answer.current = { invitations: [{ ...row, invitee: { id: "not-a-uuid", display_name: "Cara" } }] };
    await expect(drawerInvitations(drawer)).rejects.toThrow();
    answer.current = {};
    await expect(drawerInvitations(drawer)).rejects.toThrow();
  });

  it("keeps a drawer id from the address inside its path segment", async () => {
    answer.current = { invitations: [] };
    await drawerInvitations("../me");
    expect(calls[0]!.path).toBe("/drawers/..%2Fme/invitations");
  });

  it("withdraws one invitation by its id", async () => {
    await withdrawInvitation(row.id);
    expect(calls).toEqual([{ method: "DELETE", path: `/invitations/${row.id}` }]);
  });
});
