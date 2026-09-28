import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { useBack } from "../lib/nav.js";
import type { Member } from "@petty/protocol";
import { z } from "zod";
import { Button } from "../components/Button.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { Sheet } from "../components/Sheet.js";
import { TextField } from "../components/TextField.js";
import { TopBar } from "../components/TopBar.js";
import { useToast } from "../components/Toast.js";
import { api, ApiError } from "../lib/api.js";
import { cancelTransfer, inviteMember, leaveDrawer, loadAll, offerTransfer, removeMember, useDrawers, useSharingState, loadIfIdle } from "../lib/drawers.js";
import { initial } from "../lib/format.js";
import { confirmPin, memberSafetyNumber, pinStatus, usePins } from "../lib/pins.js";
import { useAuth } from "../lib/session.js";

const Lookup = z.object({ id: z.string(), display_name: z.string(), keys: z.object({ ecdh_pub: z.string(), ecdsa_pub: z.string(), sig_key_id: z.string() }).nullable() });

function SafetyNumber({ m }: { m: Member }) {
  const [n, setN] = useState("");
  useEffect(() => { void memberSafetyNumber(m).then(setN); }, [m]);
  return <span className="safety" data-testid="member-safety">{n}</span>;
}

function InviteSheet({ open, onClose, drawerId, members }: { open: boolean; onClose: () => void; drawerId: string; members: readonly Member[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  usePins();
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<z.infer<typeof Lookup> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"write" | "read">("write");
  const [compared, setCompared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [safety, setSafety] = useState("");
  useEffect(() => { if (open) { setEmail(""); setFound(null); setError(null); setRole("write"); setCompared(false); setSafety(""); } }, [open]);
  const asMember = found && found.keys ? ({ user_id: found.id, display_name: found.display_name, role: "read", keys: { ...found.keys, created_at: "", retired_at: null } } satisfies Member) : null;
  const foundId = asMember?.user_id;
  useEffect(() => { if (asMember) void memberSafetyNumber(asMember).then(setSafety); }, [foundId]); // safety number depends on the found user only
  const status = asMember ? pinStatus(asMember) : "unpinned";
  const already = found ? members.some((m) => m.user_id === found.id) : false;

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setError(null); setFound(null);
    try {
      const r = Lookup.parse(await api<unknown>("GET", `/users/lookup?email=${encodeURIComponent(email)}`));
      if (!r.keys) { setError(t("invite.noKeys")); return; }
      setFound(r);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? t("invite.notFound") : t("errors.unknown"));
    }
  }
  async function sendJoinLink() {
    setBusy(true);
    try { await api("POST", "/join-links", { email }); toast(t("invite.joinLinkSent", { email })); onClose(); } catch { setError(t("errors.unknown")); } finally { setBusy(false); }
  }
  async function invite() {
    if (!found?.keys || !asMember) return;
    setBusy(true);
    try {
      await confirmPin(found.id, found.keys);
      await inviteMember(drawerId, { id: found.id, keys: found.keys }, role);
      toast(t("invite.sent"));
      await loadAll();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "AlreadyMember" ? t("invite.alreadyMember") : t("errors.unknown"));
    } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} title={t("invite.title")} onClose={onClose}>
      <p className="hint">{t("members.honest")}</p>
      <form onSubmit={lookup} noValidate>
        <TextField label={t("invite.email")} type="email" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); setFound(null); }} error={error} autoFocus />
        {!found ? (
          <div className="actions">
            <Button variant="secondary" type="submit">{t("invite.lookup")}</Button>
            {error === t("invite.notFound") ? <Button variant="secondary" busy={busy} onClick={() => void sendJoinLink()} title={t("invite.joinLinkHint")}>{t("invite.joinLink")}</Button> : null}
          </div>
        ) : null}
      </form>
      {found && asMember ? (
        <div className="card mt8" data-testid="invite-found">
          <p className="mb6 fw700"><span className="avatar">{initial(found.display_name)}</span>{found.display_name}</p>
          <p className="hint mb4">{t("members.safety")}</p>
          <p className="safety" data-testid="invite-safety">{safety}</p>
          {already ? <p className="error" role="alert">{t("invite.alreadyMember")}</p> : null}
          {status === "changed" ? <p className="error" role="alert" data-testid="invite-blocked">{t("invite.blockedChanged")}</p> : null}
          <fieldset className="fieldset-plain">
            <legend className="hint mb6 fw600">{t("invite.role")}</legend>
            <label className="block mb6"><input type="radio" name="role" checked={role === "write"} onChange={() => setRole("write")} /> {t("invite.roleWrite")}</label>
            <label className="block"><input type="radio" name="role" checked={role === "read"} onChange={() => setRole("read")} /> {t("invite.roleRead")}</label>
          </fieldset>
          <label className="block mb12"><input type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} /> {t("invite.compare", { name: found.display_name })}</label>
          <div className="actions">
            <Button variant="secondary" onClick={onClose}>{t("app.cancel")}</Button>
            <Button busy={busy} disabled={!compared || already || status === "changed"} onClick={() => void invite()}>{t("invite.send")}</Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

export function MembersScreen() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const { id = "" } = useParams();
  const back = useBack(`/drawers/${id}`);
  const state = useDrawers();
  const { transfers } = useSharingState();
  const auth = useAuth();
  usePins();
  const [invite, setInvite] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: "remove"; m: Member } | { kind: "leave" }>(null);
  useEffect(() => { if (state.status === "idle") loadIfIdle(); }, [state.status]);
  const view = state.drawers.get(id);
  if (!view || auth.status !== "unlocked") return <><TopBar title={t("members.title")} onBack={back} /><main><p className="empty">{t("app.loading")}</p></main></>;
  const meId = auth.me.id;
  const isOwner = view.summary.role === "owner";
  const pending = transfers.find((x) => x.drawer_id === id);

  return (
    <>
      <TopBar title={t("members.title")} onBack={back} />
      <main className="stack">
        {view.members.map((m) => {
          const st = m.user_id === meId ? "confirmed" : pinStatus(m);
          return (
            <section className={`card${st === "changed" ? " problem" : ""}`} key={m.user_id} data-testid="member-card" data-status={st}>
              <p className="mb4 fw700"><span className="avatar">{initial(m.display_name)}</span>{m.display_name}{m.user_id === meId ? ` (${t("members.you")})` : ""} · <span className="hint m0">{t(`members.role.${m.role}`)}</span></p>
              <p className="hint mb2">{t("members.safety")}</p>
              <SafetyNumber m={m} />
              {m.user_id !== meId ? (
                <>
                  <p className={st === "changed" ? "error my6" : "hint my6"} role={st === "changed" ? "alert" : undefined} data-testid="pin-status">{t(`members.status.${st}`)}</p>
                  <div className="actions actions mt8 wrap">
                    {st !== "confirmed" && m.keys ? <Button variant="secondary" onClick={() => void confirmPin(m.user_id, m.keys!).then(() => toast(t("members.status.confirmed")))}>{st === "changed" ? t("members.acceptNew") : t("members.confirm")}</Button> : null}
                    {isOwner ? <Button variant="danger-ghost" onClick={() => setConfirm({ kind: "remove", m })}>{t("members.remove")}</Button> : null}
                    {isOwner && m.role === "write" && !pending ? <Button variant="secondary" onClick={() => void offerTransfer(id, m.user_id)}>{t("members.makeOwner")}</Button> : null}
                    {isOwner && pending?.to_user_id === m.user_id ? <Button variant="secondary" onClick={() => void cancelTransfer(id)}>{t("pending.cancel")}</Button> : null}
                  </div>
                  {pending?.to_user_id === m.user_id ? <p className="hint" data-testid="transfer-pending">{t("members.transferPending", { name: m.display_name })}</p> : null}
                </>
              ) : null}
            </section>
          );
        })}
        {isOwner ? <button type="button" className="addbtn" onClick={() => setInvite(true)}>+ {t("members.invite")}</button> : <Button variant="danger-ghost" onClick={() => setConfirm({ kind: "leave" })}>{t("members.leave")}</Button>}
      </main>
      <InviteSheet open={invite} onClose={() => setInvite(false)} drawerId={id} members={view.members} />
      <ConfirmSheet open={confirm?.kind === "remove"} title={t("members.remove")} body={confirm?.kind === "remove" ? t("members.removeConfirm", { name: confirm.m.display_name }) : ""} confirmLabel={t("members.remove")} onClose={() => setConfirm(null)}
        onConfirm={async () => { if (confirm?.kind === "remove") await removeMember(id, confirm.m.user_id); }} />
      <ConfirmSheet open={confirm?.kind === "leave"} title={t("members.leave")} body={t("members.leaveConfirm")} confirmLabel={t("members.leave")} onClose={() => setConfirm(null)}
        onConfirm={async () => { await leaveDrawer(id); nav("/", { replace: true }); }} />
    </>
  );
}
