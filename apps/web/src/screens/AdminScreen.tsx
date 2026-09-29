import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { useBack } from "../lib/nav.js";
import type { AdminUser } from "@petty/protocol";
import { Button } from "../components/Button.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { api, ApiError } from "../lib/api.js";
import { useAuth } from "../lib/session.js";
import { relativeTime } from "../lib/time.js";

/** Accounts, not content: block, sign out everywhere, admin flag, invite. Nothing here can open a drawer. */
export function AdminScreen() {
  const { t, i18n } = useTranslation();
  const back = useBack("/settings");
  const toast = useToast();
  const auth = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { u: AdminUser; what: "block" | "revoke" | "makeAdmin" | "removeAdmin" }>(null);
  const load = () => api<{ users: AdminUser[] }>("GET", "/admin/users").then((r) => setUsers(r.users)).catch((e) => setError(e instanceof ApiError && e.status === 403 ? t("admin.forbidden") : t("errors.unknown")));
  useEffect(() => { void load(); }, []);
  if (auth.status === "unlocked" && !auth.me.is_admin) return <Navigate to="/" replace />;
  const meId = auth.status === "unlocked" ? auth.me.id : "";

  async function act(u: AdminUser, what: "block" | "unblock" | "revoke" | "makeAdmin" | "removeAdmin") {
    const admin = what === "makeAdmin" || what === "removeAdmin";
    const path = what === "revoke" ? `/admin/users/${u.id}/revoke-sessions` : `/admin/users/${u.id}/${admin ? "admin" : what}`;
    try {
      await api("POST", path, admin ? { is_admin: what === "makeAdmin" } : undefined);
      toast(t(`admin.done.${what}`));
      await load();
    } catch { toast(t("errors.unknown")); }
  }
  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await api("POST", "/join-links", { email: inviteEmail }); toast(t("invite.joinLinkSent", { email: inviteEmail })); setInviteEmail(""); }
    catch { toast(t("errors.unknown")); } finally { setBusy(false); }
  }

  return (
    <>
      <TopBar title={t("admin.title")} onBack={back} />
      <main className="stack">
        <section className="card">
          <h2 className="h-card">{t("admin.inviteTitle")}</h2>
          <form onSubmit={invite} noValidate>
            <TextField label={t("admin.inviteEmail")} type="email" inputMode="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
            <Button type="submit" variant="secondary" busy={busy} disabled={!inviteEmail.includes("@")}>{t("admin.inviteSend")}</Button>
          </form>
        </section>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {users === null && !error ? <p className="empty">{t("app.loading")}</p> : null}
        {users?.map((u) => (
          <section className={`card${u.blocked_at ? " problem" : ""}`} key={u.id} data-testid="admin-user" data-email={u.email}>
            <p className="mb2 fw700">{u.display_name}{u.id === meId ? ` (${t("members.you")})` : ""}{u.is_admin ? ` · ${t("admin.badgeAdmin")}` : ""}{u.blocked_at ? ` · ${t("admin.badgeBlocked")}` : ""}{u.deleted ? ` · ${t("admin.badgeDeleted")}` : ""}</p>
            <p className="hint mb2">{u.email}</p>
            <p className="hint mb8">{t("admin.meta", { owned: u.owned, seen: u.last_seen_at ? relativeTime(u.last_seen_at, i18n.language, t) : t("admin.never"), passkey: u.has_passkey ? t("app.yes") : t("app.no") })}</p>
            {u.id !== meId && !u.deleted ? (
              <div className="actions wrap m0">
                {u.blocked_at ? <Button variant="secondary" onClick={() => void act(u, "unblock")}>{t("admin.unblock")}</Button> : <Button variant="danger-ghost" onClick={() => setConfirm({ u, what: "block" })}>{t("admin.block")}</Button>}
                <Button variant="secondary" onClick={() => setConfirm({ u, what: "revoke" })}>{t("admin.revoke")}</Button>
                {/* PETTY-281: the sheet says which way the change goes, and its button does what it says */}
                <Button variant="secondary" onClick={() => setConfirm({ u, what: u.is_admin ? "removeAdmin" : "makeAdmin" })}>{u.is_admin ? t("admin.removeAdmin") : t("admin.makeAdmin")}</Button>
              </div>
            ) : null}
          </section>
        ))}
      </main>
      <ConfirmSheet open={confirm !== null} title={confirm ? t(`admin.confirm.${confirm.what}.title`, { name: confirm.u.display_name }) : ""} body={confirm ? t(`admin.confirm.${confirm.what}.body`) : ""}
        confirmLabel={confirm ? t(`admin.confirm.${confirm.what}.ok`) : ""} danger={confirm?.what === "block"} onClose={() => setConfirm(null)} onConfirm={() => (confirm ? act(confirm.u, confirm.what) : undefined)} />
    </>
  );
}
