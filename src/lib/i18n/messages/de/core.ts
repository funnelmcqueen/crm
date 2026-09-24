import type en from "../en/core";

const de: { [K in keyof typeof en]: string } = {
  skipToContent: "Zum Inhalt springen",
  settings: "Einstellungen",
  signOut: "Abmelden",
  signingOut: "Wird abgemeldet...",
  signOutError: "Abmelden fehlgeschlagen. Prüfe deine Verbindung und versuche es erneut. Deine Entwürfe sind noch vorhanden.",
  accountMenu: "Kontomenü für {name}",
  language: "Sprache",
  assignedLanguage: "Zugewiesene Sprache verwenden",
  english: "English",
  german: "Deutsch",
  signIn: "Anmelden",
  signingIn: "Wird angemeldet...",
  email: "E-Mail",
  password: "Passwort",
  accountDisabled: "Konto deaktiviert",
  disabledMessage: "Dein Konto wurde deaktiviert. Wende dich an den Administrator, falls dies ein Fehler ist.",
};

export default de;
