/**
 * Every email Petty sends, in each language the app speaks (PETTY-249). A mail goes out in the
 * recipient's language (users.locale, set at signup and from Settings); a join link — sent to someone
 * without an account yet — goes out in the inviter's. Plain text; names and links only, never drawer
 * content (spec "Notification").
 */
export const MAIL_LOCALES = ["en", "pl", "de", "es", "fr"] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];
export const mailLocale = (x: string | null | undefined): MailLocale => ((MAIL_LOCALES as readonly string[]).includes(x ?? "") ? (x as MailLocale) : "en");

export interface MailText { readonly subject: string; readonly text: string }
type Role = "write" | "read";
interface Catalog {
  joinLink(inviter: string, link: string): MailText;
  invitation(inviter: string, role: Role, app: string): MailText;
  relinked(app: string): MailText;
  revoked(owner: string): MailText;
  transferOffered(owner: string, app: string): MailText;
  transferDone(newOwner: string): MailText;
  passwordReset(link: string): MailText;
  passwordChanged(): MailText;
  vaultReplaced(): MailText;
  handedOver(from: string): MailText;
}

export const MAIL: Record<MailLocale, Catalog> = {
  en: {
    joinLink: (inviter, link) => ({ subject: "You are invited to Petty", text: `${inviter} invited you to Petty, where you keep track of what you have and where it is.\n\nCreate your account here (the link works once, for 7 days):\n${link}\n` }),
    invitation: (inviter, role, app) => ({ subject: "A drawer was shared with you", text: `${inviter} invited you to a drawer in Petty as ${role === "write" ? "a writer" : "a reader"}.\n\nOpen Petty to accept or decline: ${app}/\n` }),
    relinked: (app) => ({ subject: "A new sign-in method was linked to your Petty account", text: `Your Petty account is now reached through a new sign-in (for example Google or GitHub) for this address. Your vault did not change and still needs your passphrase or passkey.\n\nIf this was not you, tell the person who runs your Petty right away: ${app}/\n` }),
    revoked: (owner) => ({ subject: "Your access to a drawer ended", text: `${owner} removed you from a shared drawer in Petty. You keep nothing that was shared after this moment.\n` }),
    transferOffered: (owner, app) => ({ subject: "You were offered a drawer", text: `${owner} wants to hand a drawer over to you in Petty. Open Petty to accept: ${app}/\n` }),
    transferDone: (newOwner) => ({ subject: "Ownership transferred", text: `${newOwner} accepted your drawer in Petty and now owns it. You stay a writer.\n` }),
    passwordReset: (link) => ({ subject: "Reset your Petty login password", text: `Someone (we hope you) asked to reset the login password for Petty.\n\nSet a new one here (the link works once, for one hour):\n${link}\n\nThis changes the login password only. Your vault passphrase and recovery code stay as they are — nobody can reset those.\nIf this was not you, ignore this message.\n` }),
    passwordChanged: () => ({ subject: "Your Petty login password was changed", text: "The login password for your Petty account was just changed through a reset link.\n\nIf that was you, all is well. If not, sign in and change it, or write to us.\nYour vault passphrase and recovery code are unchanged.\n" }),
    vaultReplaced: () => ({ subject: "Your Petty vault passphrase was changed", text: "The vault passphrase (or recovery code) of your Petty account was just changed from an unlocked device.\n\nIf that was not you, write to us: the previous version can be restored for 30 days.\n" }),
    handedOver: (from) => ({ subject: "A drawer is now yours", text: `${from} deleted their Petty account and handed one of their drawers to you. You are its owner now.\n` }),
  },
  pl: {
    joinLink: (inviter, link) => ({ subject: "Zaproszenie do Petty", text: `${inviter} zaprasza Cię do Petty — miejsca, w którym wiesz, co masz i gdzie to leży.\n\nZałóż konto tutaj (link działa raz, przez 7 dni):\n${link}\n` }),
    invitation: (inviter, role, app) => ({ subject: "Udostępniono Ci szufladę", text: `${inviter} zaprasza Cię do szuflady w Petty — ${role === "write" ? "z prawem zapisu" : "tylko do odczytu"}.\n\nOtwórz Petty, aby przyjąć lub odrzucić zaproszenie: ${app}/\n` }),
    relinked: (app) => ({ subject: "Do Twojego konta Petty dodano nowy sposób logowania", text: `Do Twojego konta Petty z tym adresem e-mail można się teraz logować w nowy sposób (na przykład przez Google lub GitHub). Twój sejf się nie zmienił i nadal wymaga hasła sejfu lub klucza dostępu.\n\nJeśli to nie Ty, od razu powiadom osobę, która prowadzi Twoje Petty: ${app}/\n` }),
    revoked: (owner) => ({ subject: "Twój dostęp do szuflady się zakończył", text: `Usunięto Cię z udostępnionej szuflady w Petty (właściciel: ${owner}). Od tej chwili nie zobaczysz w niej nic nowego.\n` }),
    transferOffered: (owner, app) => ({ subject: "Zaproponowano Ci szufladę", text: `${owner} chce przekazać Ci szufladę w Petty. Otwórz Petty, aby ją przyjąć: ${app}/\n` }),
    transferDone: (newOwner) => ({ subject: "Własność przekazana", text: `Twoja szuflada w Petty ma nowego właściciela: ${newOwner}. Nadal masz w niej prawo zapisu.\n` }),
    passwordReset: (link) => ({ subject: "Reset hasła logowania w Petty", text: `Ktoś (mamy nadzieję, że Ty) poprosił o reset hasła logowania w Petty.\n\nUstaw nowe hasło tutaj (link działa raz, przez godzinę):\n${link}\n\nTo zmienia tylko hasło logowania. Hasło sejfu i kod odzyskiwania pozostają bez zmian — nikt nie może ich zresetować.\nJeśli to nie Ty, zignoruj tę wiadomość.\n` }),
    passwordChanged: () => ({ subject: "Hasło logowania do Petty zostało zmienione", text: "Hasło logowania do Twojego konta Petty właśnie zostało zmienione przez link resetujący.\n\nJeśli to Ty — wszystko w porządku. Jeśli nie, zaloguj się i zmień hasło albo napisz do nas.\nHasło sejfu i kod odzyskiwania pozostają bez zmian.\n" }),
    vaultReplaced: () => ({ subject: "Hasło sejfu w Petty zostało zmienione", text: "Hasło sejfu (lub kod odzyskiwania) Twojego konta Petty zostało właśnie zmienione z odblokowanego urządzenia.\n\nJeśli to nie Ty, napisz do nas: poprzednią wersję można przywrócić przez 30 dni.\n" }),
    handedOver: (from) => ({ subject: "Szuflada należy teraz do Ciebie", text: `${from} usuwa swoje konto Petty i przekazuje Ci jedną ze swoich szuflad. Od teraz należy do Ciebie.\n` }),
  },
  de: {
    joinLink: (inviter, link) => ({ subject: "Du bist zu Petty eingeladen", text: `${inviter} hat dich zu Petty eingeladen – dort weißt du, was du hast und wo es liegt.\n\nErstelle hier dein Konto (der Link funktioniert einmal, 7 Tage lang):\n${link}\n` }),
    invitation: (inviter, role, app) => ({ subject: "Eine Schublade wurde mit dir geteilt", text: `${inviter} hat dich in Petty zu einer Schublade eingeladen – ${role === "write" ? "als Bearbeiter" : "als Leser"}.\n\nÖffne Petty, um anzunehmen oder abzulehnen: ${app}/\n` }),
    relinked: (app) => ({ subject: "Neue Anmeldemethode für dein Petty-Konto", text: `Dein Petty-Konto ist jetzt über eine neue Anmeldung (zum Beispiel Google oder GitHub) für diese Adresse erreichbar. Dein Tresor hat sich nicht geändert und braucht weiterhin deine Passphrase oder deinen Passkey.\n\nWenn du das nicht warst, sag sofort der Person Bescheid, die dein Petty betreibt: ${app}/\n` }),
    revoked: (owner) => ({ subject: "Dein Zugriff auf eine Schublade wurde beendet", text: `${owner} hat dich aus einer geteilten Schublade in Petty entfernt. Was ab jetzt darin geteilt wird, siehst du nicht mehr.\n` }),
    transferOffered: (owner, app) => ({ subject: "Dir wurde eine Schublade angeboten", text: `${owner} möchte dir in Petty eine Schublade übergeben. Öffne Petty, um anzunehmen: ${app}/\n` }),
    transferDone: (newOwner) => ({ subject: "Eigentum übertragen", text: `${newOwner} hat deine Schublade in Petty angenommen und ist jetzt Eigentümer. Du bleibst Bearbeiter.\n` }),
    passwordReset: (link) => ({ subject: "Setze dein Petty-Anmeldepasswort zurück", text: `Jemand (hoffentlich du) hat das Zurücksetzen des Anmeldepassworts für Petty angefordert.\n\nLege hier ein neues fest (der Link funktioniert einmal, eine Stunde lang):\n${link}\n\nDas ändert nur das Anmeldepasswort. Deine Tresor-Passphrase und dein Wiederherstellungscode bleiben, wie sie sind – niemand kann sie zurücksetzen.\nWenn du das nicht warst, ignoriere diese Nachricht.\n` }),
    passwordChanged: () => ({ subject: "Dein Petty-Anmeldepasswort wurde geändert", text: "Das Anmeldepasswort deines Petty-Kontos wurde gerade über einen Link zum Zurücksetzen geändert.\n\nWenn du das warst, ist alles in Ordnung. Wenn nicht, melde dich an und ändere es oder schreib uns.\nDeine Tresor-Passphrase und dein Wiederherstellungscode sind unverändert.\n" }),
    vaultReplaced: () => ({ subject: "Deine Petty-Tresor-Passphrase wurde geändert", text: "Die Tresor-Passphrase (oder der Wiederherstellungscode) deines Petty-Kontos wurde gerade auf einem entsperrten Gerät geändert.\n\nWenn du das nicht warst, schreib uns: Die vorherige Version lässt sich 30 Tage lang wiederherstellen.\n" }),
    handedOver: (from) => ({ subject: "Eine Schublade gehört jetzt dir", text: `${from} hat das eigene Petty-Konto gelöscht und dir eine Schublade übergeben. Sie gehört jetzt dir.\n` }),
  },
  es: {
    joinLink: (inviter, link) => ({ subject: "Te han invitado a Petty", text: `${inviter} te ha invitado a Petty, donde llevas el control de lo que tienes y de dónde está.\n\nCrea tu cuenta aquí (el enlace funciona una vez, durante 7 días):\n${link}\n` }),
    invitation: (inviter, role, app) => ({ subject: "Han compartido un cajón contigo", text: `${inviter} te ha invitado a un cajón en Petty ${role === "write" ? "como editor" : "como lector"}.\n\nAbre Petty para aceptar o rechazar: ${app}/\n` }),
    relinked: (app) => ({ subject: "Se vinculó un nuevo método de acceso a tu cuenta de Petty", text: `Ahora se puede acceder a tu cuenta de Petty con un nuevo método de inicio de sesión (por ejemplo, Google o GitHub) vinculado a esta dirección. Tu bóveda no ha cambiado y sigue necesitando tu frase de contraseña o tu llave de acceso.\n\nSi no has sido tú, avisa enseguida a quien gestiona tu Petty: ${app}/\n` }),
    revoked: (owner) => ({ subject: "Tu acceso a un cajón ha terminado", text: `${owner} te ha quitado de un cajón compartido en Petty. Ya no verás nada de lo que se comparta en él a partir de ahora.\n` }),
    transferOffered: (owner, app) => ({ subject: "Te han ofrecido un cajón", text: `${owner} quiere traspasarte un cajón en Petty. Abre Petty para aceptarlo: ${app}/\n` }),
    transferDone: (newOwner) => ({ subject: "Propiedad traspasada", text: `${newOwner} ha aceptado tu cajón en Petty y ahora es su propietario. Tú sigues como editor.\n` }),
    passwordReset: (link) => ({ subject: "Restablece tu contraseña de acceso a Petty", text: `Alguien (esperamos que tú) ha pedido restablecer la contraseña de acceso a Petty.\n\nElige una nueva aquí (el enlace funciona una vez, durante una hora):\n${link}\n\nEsto solo cambia la contraseña de acceso. La frase de contraseña de tu bóveda y tu código de recuperación no cambian: nadie puede restablecerlos.\nSi no has sido tú, ignora este mensaje.\n` }),
    passwordChanged: () => ({ subject: "Se cambió tu contraseña de acceso a Petty", text: "La contraseña de acceso de tu cuenta de Petty se acaba de cambiar con un enlace de restablecimiento.\n\nSi has sido tú, todo está bien. Si no, inicia sesión y cámbiala, o escríbenos.\nLa frase de contraseña de tu bóveda y tu código de recuperación no han cambiado.\n" }),
    vaultReplaced: () => ({ subject: "Se cambió la frase de contraseña de tu bóveda de Petty", text: "La frase de contraseña de la bóveda (o el código de recuperación) de tu cuenta de Petty se acaba de cambiar desde un dispositivo desbloqueado.\n\nSi no has sido tú, escríbenos: la versión anterior se puede restaurar durante 30 días.\n" }),
    handedOver: (from) => ({ subject: "Te han traspasado un cajón", text: `${from} eliminó su cuenta de Petty y te traspasó uno de sus cajones. Ahora es tuyo.\n` }),
  },
  fr: {
    joinLink: (inviter, link) => ({ subject: "Invitation à Petty", text: `${inviter} vous invite sur Petty, pour savoir ce que vous avez et où cela se trouve.\n\nCréez votre compte ici (le lien fonctionne une fois, pendant 7 jours)\u00a0:\n${link}\n` }),
    invitation: (inviter, role, app) => ({ subject: "Un tiroir a été partagé avec vous", text: `${inviter} vous invite dans un tiroir sur Petty ${role === "write" ? "en tant qu’éditeur" : "en tant que lecteur"}.\n\nOuvrez Petty pour accepter ou refuser\u00a0: ${app}/\n` }),
    relinked: (app) => ({ subject: "Un nouveau moyen de connexion a été lié à votre compte Petty", text: `Votre compte Petty est désormais accessible avec une nouvelle connexion (par exemple Google ou GitHub) pour cette adresse. Votre coffre n’a pas changé et demande toujours votre phrase secrète ou votre clé d’accès.\n\nSi ce n’était pas vous, prévenez tout de suite la personne qui gère votre Petty\u00a0: ${app}/\n` }),
    revoked: (owner) => ({ subject: "Votre accès à un tiroir a pris fin", text: `${owner} vous a retiré d’un tiroir partagé sur Petty. Vous ne verrez plus rien de ce qui y sera partagé à partir de maintenant.\n` }),
    transferOffered: (owner, app) => ({ subject: "On vous propose un tiroir", text: `${owner} souhaite vous transférer un tiroir sur Petty. Ouvrez Petty pour accepter\u00a0: ${app}/\n` }),
    transferDone: (newOwner) => ({ subject: "Propriété transférée", text: `${newOwner} a accepté votre tiroir sur Petty et en est désormais propriétaire. Vous restez éditeur.\n` }),
    passwordReset: (link) => ({ subject: "Réinitialisez votre mot de passe de connexion Petty", text: `Quelqu’un (vous, nous l’espérons) a demandé à réinitialiser le mot de passe de connexion de Petty.\n\nChoisissez-en un nouveau ici (le lien fonctionne une fois, pendant une heure)\u00a0:\n${link}\n\nCela ne change que le mot de passe de connexion. La phrase secrète de votre coffre et votre code de récupération restent inchangés — personne ne peut les réinitialiser.\nSi ce n’était pas vous, ignorez ce message.\n` }),
    passwordChanged: () => ({ subject: "Votre mot de passe de connexion Petty a été modifié", text: "Le mot de passe de connexion de votre compte Petty vient d’être modifié via un lien de réinitialisation.\n\nSi c’était vous, tout va bien. Sinon, connectez-vous et changez-le, ou écrivez-nous.\nLa phrase secrète de votre coffre et votre code de récupération sont inchangés.\n" }),
    vaultReplaced: () => ({ subject: "La phrase secrète de votre coffre Petty a été modifiée", text: "La phrase secrète du coffre (ou le code de récupération) de votre compte Petty vient d’être modifiée depuis un appareil déverrouillé.\n\nSi ce n’était pas vous, écrivez-nous\u00a0: la version précédente peut être restaurée pendant 30 jours.\n" }),
    handedOver: (from) => ({ subject: "Un tiroir est désormais à vous", text: `${from} a supprimé son compte Petty et vous a transmis l’un de ses tiroirs. Il est désormais à vous.\n` }),
  },
};
