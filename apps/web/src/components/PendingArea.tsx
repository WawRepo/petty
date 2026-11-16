import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Invitation } from "@petty/protocol";
import { Button } from "./Button.js";
import { acceptInvitation, acceptTransfer, cancelTransfer, declineInvitation, useDrawers, useSharingState, type Transfer } from "../lib/drawers.js";
import { confirmPin, memberSafetyNumber, pinStatus, usePins } from "../lib/pins.js";
import { useAuth } from "../lib/session.js";
import { ApiError, NetworkError } from "../lib/api.js";
import { useToast } from "./Toast.js";

/** PETTY-461: a choice on a card that did not go through says so on the card. */
function useFailure(): [string | null, <T>(p: Promise<T>) => Promise<T | undefined>] {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(p: Promise<T>): Promise<T | undefined> => {
    setError(null);
    try { return await p; } catch (e) { setError(t(e instanceof NetworkError ? "errors.network" : "errors.unknown")); return undefined; }
  };
  return [error, run];
}

function InvitationCard({ inv }: { inv: Invitation }) {
  const { t } = useTranslation();
  const [safety, setSafety] = useState("");
  const [compared, setCompared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, run] = useFailure();
  const toast = useToast();
  usePins();
  // PETTY-447: other keys than the ones pinned for the inviter are a key change. It is shown, and the invitation waits until
  // the new key is accepted as such, as in Members. Ticking "I compared" never puts a new key in a pin's place.
  const changed = inv.inviter.keys !== null && pinStatus({ user_id: inv.inviter.id, display_name: inv.inviter.display_name, role: "owner", keys: inv.inviter.keys }) === "changed";
  useEffect(() => { if (inv.inviter.keys) void memberSafetyNumber({ user_id: inv.inviter.id, display_name: inv.inviter.display_name, role: "owner", keys: inv.inviter.keys }).then(setSafety); }, [inv]);
  return (
    <section className="card" data-testid="pending-invitation">
      <p className="mb6">{t("pending.invitation", { name: inv.inviter.display_name, role: t(`pending.role.${inv.role}`) })}</p>
      <p className="hint mb2">{t("pending.safety")}</p>
      <p className="safety" data-testid="inviter-safety">{safety}</p>
      {changed ? <p className="warn-box danger" role="alert" data-testid="inviter-key-changed">{t("members.status.changed")} <Button variant="ghost" onClick={() => { setCompared(false); if (inv.inviter.keys) void run(confirmPin(inv.inviter.id, inv.inviter.keys)); }}>{t("members.acceptNew")}</Button></p> : null}
      <label className="check-row my10"><input type="checkbox" checked={compared && !changed} disabled={changed} onChange={(e) => setCompared(e.target.checked)} /><span>{t("pending.compare", { name: inv.inviter.display_name })}</span></label>
      <div className="actions">
        <Button variant="secondary" busy={busy} onClick={() => { setBusy(true); void run(declineInvitation(inv.id)).finally(() => setBusy(false)); }}>{t("pending.decline")}</Button>
        <Button busy={busy} disabled={!compared || changed} onClick={async () => { if (changed) return; setBusy(true); try { await run((async () => {
          if (inv.inviter.keys) await confirmPin(inv.inviter.id, inv.inviter.keys);
          // PETTY-461: an out-of-date invitation is gone after this; its card goes with it, so the reason is a toast
          try { await acceptInvitation(inv.id); } catch (e) { if (e instanceof ApiError && e.code === "InvitationStale") { toast(t("pending.stale", { name: inv.inviter.display_name })); return; } throw e; }
        })()); } finally { setBusy(false); } }}>{t("pending.accept")}</Button>
      </div>
      {error ? <p className="error" role="alert" data-testid="pending-error">{error}</p> : null}
    </section>
  );
}

function TransferCard({ tr }: { tr: Transfer }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const state = useDrawers();
  const view = state.drawers.get(tr.drawer_id);
  const name = (id: string) => view?.members.find((m) => m.user_id === id)?.display_name ?? "?";
  const [error, run] = useFailure();
  if (auth.status !== "unlocked") return null;
  if (tr.to_user_id === auth.me.id) {
    return (
      <section className="card" data-testid="pending-transfer">
        <p className="mb10">{t("pending.transferOffer", { name: name(tr.from_user_id) })}</p>
        <div className="actions">
          <Button variant="secondary" onClick={() => void run(cancelTransfer(tr.drawer_id))}>{t("pending.transferDecline")}</Button>
          <Button onClick={() => void run(acceptTransfer(tr.drawer_id))}>{t("pending.transferAccept")}</Button>
        </div>
        {error ? <p className="error" role="alert" data-testid="pending-error">{error}</p> : null}
      </section>
    );
  }
  return (
    <section className="card" data-testid="pending-transfer-out">
      <p className="m0 hint">{t("pending.transferWaiting", { name: name(tr.to_user_id), drawer: view?.doc?.name ?? "…" })}</p>
    </section>
  );
}

/** Invitations and ownership offers, shown on launch (spec "Notification": in-app). */
export function PendingArea() {
  const { t } = useTranslation();
  useDrawers();
  const { invitations, transfers } = useSharingState();
  if (!invitations.length && !transfers.length) return null;
  return (
    <div className="stack mb16" data-testid="pending-area">
      <h2 className="section mt8 mb0">{t("pending.title")}</h2>
      {invitations.map((inv) => <InvitationCard key={inv.id} inv={inv} />)}
      {transfers.map((tr) => <TransferCard key={tr.drawer_id} tr={tr} />)}
    </div>
  );
}
