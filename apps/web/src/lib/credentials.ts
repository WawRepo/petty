/**
 * Let the user's password manager keep the vault passphrase (their choice, their
 * manager's encryption). Two mechanisms:
 *  - form hints: a hidden username "email · vault" + autocomplete current/new-password
 *    on the passphrase fields, so Chrome, Safari, 1Password, Bitwarden treat it as a
 *    second credential for this site (see UnlockScreen, JoinScreen, custody forms);
 *  - the Credential Management API, where the browser has it (Chrome), asked to store
 *    the credential right after signup / a passphrase change, because the app unlocks
 *    programmatically then and no form submit would trigger the manager.
 */
export const vaultUsername = (email: string): string => `${email} · vault`;

export async function offerToSavePassphrase(email: string, passphrase: string): Promise<void> {
  const w = window as unknown as { PasswordCredential?: new (init: { id: string; password: string; name?: string }) => Credential };
  if (!w.PasswordCredential || !navigator.credentials?.store) return;
  try {
    await navigator.credentials.store(new w.PasswordCredential({ id: vaultUsername(email), password: passphrase, name: "Petty vault passphrase" }));
  } catch { /* the user declined or the API is unavailable: nothing to do */ }
}
