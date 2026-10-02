/**
 * Copy for the consent page and Connected apps (docs/phases/PHASE_19.md,
 * "Consent page", P19-09 and P19-10). Rule 9: plain spoken, no emojis, no
 * arrows, no dashes as punctuation. These pages sit inside the ChatGPT
 * connect flow, so like the MCP copy they never mention plans, prices or an
 * upgrade (consent-copy.test.ts runs the rule 9 lint and the MCP banned
 * word list over every line).
 */

/** The OIDC scopes Supabase's OAuth server can grant (docs/verification.md,
 * "PHASE_19", SB1 and SB4 oauth_scope.go), in the order the page lists them,
 * each with the plain words for what ChatGPT receives. */
export const SCOPE_LINES: Readonly<Record<string, string>> = {
  openid: "A private id for your Curvi account",
  email: "Your email address",
  profile: "Your name and picture, if your account has them",
  phone: "Your phone number, if your account has one",
  offline_access: "Access that stays on until you disconnect",
};

/** The scopes Curvi itself needs (lib/mcp-auth/config.ts MCP_REQUIRED_SCOPES). */
export const SCOPES_CURVI_USES: readonly string[] = ["openid", "email"];

export const CONSENT_COPY = {
  title: "Connect ChatGPT to Curvi",
  signInLead: "Log in or create a Curvi account to connect ChatGPT.",
  logInTab: "Log in",
  signUpTab: "Create an account",
  signUpButton: "Create account",
  signUpSent:
    "Almost there. We sent a confirmation link to your inbox. Open it on any device to come back here and finish connecting ChatGPT. Check spam if it does not arrive in a minute.",
  resetSentNote:
    "After you set a new password, come back to this page and log in. If this page has expired by then, press Connect in ChatGPT again.",
  signedInAs: (email: string | null): string => (email ? `Signed in as ${email}.` : "Signed in to your Curvi account."),
  useAnotherAccount: "Use another account",
  ableHeading: "ChatGPT will be able to:",
  able: [
    "Make packs in the workspace you pick. Each pack uses credits from that workspace, and Curvi tells ChatGPT how many before it starts.",
    "Read your packs and get their preview and download links.",
    "Check main images. This uses no credits.",
  ],
  receiveHeading: "ChatGPT will receive:",
  unknownScope: (scope: string): string => `A permission named ${scope}`,
  extraScopesNote: "ChatGPT asks for these by default. Curvi does not use them.",
  assurance:
    "ChatGPT never sees your password and cannot see your payment details. You will go back to chatgpt.com.",
  currentWorkspace: (workspace: string): string =>
    `ChatGPT now uses ${workspace}. Picking another moves every ChatGPT and Codex connection on your account to it.`,
  pickerLabel: "Which workspace should ChatGPT use?",
  connect: "Connect",
  connecting: "Connecting",
  cancel: "Cancel",
  footer: "You can disconnect at any time in Settings, Connected apps.",
  expired: "This connection request expired. Go back to ChatGPT and press Connect again.",
  switchedAccount:
    "You switched accounts, so this connection request ended. Go back to ChatGPT and press Connect again to connect this account.",
  nothingShared: "Nothing was shared. You can close this page.",
  unknownClient: "Curvi does not work with this app yet, so nothing was shared.",
  unavailable:
    "Curvi could not open this connection request right now, so nothing was shared. Go back to ChatGPT and press Connect again in a few minutes.",
  noWorkspace:
    "Curvi could not find a workspace for this account, so nothing was shared. Email hello@curvi.ai and we will sort it out.",
  notYourWorkspace: "That workspace is not one of yours, so nothing was shared. Pick one from the list.",
  pickWorkspace: "Pick the workspace ChatGPT should use.",
} as const;

export const CONNECTED_APPS_COPY = {
  title: "Connected apps",
  intro: "Assistants such as ChatGPT that can use your Curvi workspaces. Disconnect one and it stops at once.",
  defaultClientName: "ChatGPT",
  row: (workspace: string): string => `ChatGPT can make packs in ${workspace} using its credits.`,
  unknownWorkspace: "a workspace you no longer belong to",
  connectedBy: (member: string): string => `Connected by ${member}.`,
  someone: "another member",
  connectedOn: (date: string): string => `Connected on ${date}.`,
  lastUsed: (date: string): string => `Last used on ${date}.`,
  notUsed: "Not used yet.",
  disconnect: "Disconnect",
  disconnected:
    "Disconnected. ChatGPT can no longer use this workspace, and links it already shared stop working.",
  empty: "Nothing is connected yet. When you connect Curvi in ChatGPT, it shows up here.",
  notAllowed: "Only owners and admins can disconnect another member's connection.",
  alreadyDisconnected: "This connection is already disconnected.",
  signIn: "Sign in to see connected apps.",
  unavailable: "Connected apps are not available right now. Try again in a few minutes.",
  settingsCard: "See which assistants, such as ChatGPT, can use your workspace, and disconnect them.",
  settingsLink: "Manage connected apps",
} as const;
