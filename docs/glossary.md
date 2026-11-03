# Wording glossary

One word per concept, in every user-facing string. Code names can differ (`board`, `turn`, `devServer`).

## Rules

- **Capitalization.** Native menus, menu-bar items, context menus (`Menu.buildFromTemplate`) and native dialog buttons use macOS Title Case: "Move Tab to New Window", "New Chat", "Restart Now". Everything else in the app UI uses sentence case: "Close tab", "Get latest", "Archived chats". When app UI names a menu command (the Keyboard Shortcuts list, "Settings → Agents"), it keeps the menu's casing.
- **"…" means "asks for more first".** Use the single `…` character, only on items that open a dialog, sheet or picker before acting.
- **Name what the user sees.** Say "your app", "the preview", "this chat", not the mechanism behind it (process, session, PATH, ACP).
- **Plain words over git and dev jargon.** Gui leaves Git to the agent and the terminal; where it does name Git things (the toolbar's branch, Clone…), it uses the words below, which users also see on GitHub.
- **A label says what happens.** Use "Show chat" or "Hide chat", never "Toggle chat". A status word describes the current state, and a button names the next action.
- **Stop is for things that run.** Cancel only closes a dialog without doing anything, and closing it shows no message. Never show "Cancelled." as an error.
- **Contractions, no "please".** "Couldn't save the recording", not "Could not" or "Please try again". Errors say what happened and what to do next.
- **Plain words over error codes.** Show what happened ("Nothing is answering at localhost:5173") and keep codes like `ERR_CONNECTION_REFUSED` or exit codes behind Details.

## Words

| Use | Don't use | Where it shows up | Note |
|---|---|---|---|
| canvas | board, design board | canvas list, menus, aria labels, start screen, agent prompt | Internal `board` names stay |
| frame | artboard | canvas | |
| project | app (as the thing you open), folder, repo | "Switch App…" in `tab.ts` → "Switch Project…" | Use **folder** only for a place on disk ("Reveal in Finder") |
| app | site, server | preview, empty states | What the project builds and the preview shows |
| preview | page, browser view | toolbar, shortcuts | **page** is one address inside the preview. **browser** is the user's own browser ("Open in Browser") |
| website | site, external page, off-site page | address bar, agent prompt and tool results | A public site that isn't the user's app, which the agent opens in the preview to use like a user ("how does linear.app do onboarding?"), in a separate, signed-out session. The address bar shows its address; the way back is **Back to your app** |
| dev server | server, start command, "Start app" | drawer, View menu, setup cards | Sentences about what the user sees say "your app": "Your app stopped". The command field is "Dev server command"; the button is "Start dev server" ("Start Dev Server" in menus and dialogs) |
| Trust project, Trusted projects | Allow, approve | trust prompts (dev server, agent), Settings → Projects | One switch: a trusted project runs its dev server and agents without asking |
| dependencies | packages | setup cards, address bar status | "Installing dependencies…", "Gui will install its dependencies and start it" |
| Design mode | Select element, selection mode, picking (as the mode's name) | toolbar tooltip, View menu ("Design Mode"), chat bubble ("Exits design mode"), empty chat, agent prompt | The ⌘D mode. Inside it the user selects elements and areas. Code names (`selectElement`, `selecting`) stay |
| select | pick, picked | composer and message lists ("Selected", "2 selected") | Code names (`Picked`, `pick/`) stay |
| Show as sidebar / Show as floating panel | Float panel, Dock | chat header (`chat-panel.tsx`) | Menu: "Chat as Sidebar". Settings: "Show the chat as a sidebar" |
| Clone… | Clone by URL, Open from GitHub | start screen, File and project menus (⇧⌘O) | One form: connected GitHub repositories above the address field, or Connect GitHub |
| Undo / Undo to here | — | message result (`turn-view.tsx`) | "Undo to here" on an older message undoes the later ones too, and asks first: "Undo this and 2 later messages? You can redo." ⌘Z acts on the agent's change only while the chat is showing |
| Stop / Stopped | Cancel, Cancelled (as a status) | composer, turn view (`turn-view.tsx:716`), dev server | A question the user's stop interrupted reads "Stopped". One that timed out reads "Expired" |
| Restart | Start again | dev server, terminal (`canvas.tsx:237,243`, `drawer.tsx`) | Use "Start" if it never ran. **Try again** is for a one-off step that failed (install, sign-in, load) |
| Show chat / Hide chat | Toggle chat | toolbar tooltip (`toolbar.tsx:151,195`) | Menu: "Show Chat" / "Hide Chat". Shortcuts list: "Show or Hide Chat". Same for Terminal |
| logs | output | dev server and install errors (`LogsToggle noun="output"`) | "Show logs" / "Hide logs" |
| chat | conversation, thread, session | chat UI, errors (`store.ts:489`) | "New Chat", "Archived Chats" in menus |
| message | turn | "before this turn" tooltip (`turn-view.tsx:1076`), Settings clear dialog | "Restore files to how they were before this message". "You can no longer undo changes from past chats." |
| version | checkpoint, snapshot | Settings → Storage ("Checkpoints · Snapshots that power Undo") | Matches "Versions…". Use "Versions · Saved states that power Undo" |
| Ready | Installed (as a status) | agent status on start screen and Settings (`agent-status.tsx`) | An agent Gui found but hasn't checked yet reads **Not checked**, with a **Check now** button. Replaces "Check" |
| Not installed | not on your PATH | Settings, Agent menu sublabel | Button: "Install {name}". Hint: "Gui can't find the `x` command on this Mac." |
| Turn on / Off | Enable, Enabled | agent card, Settings agent switch (`agent-row.tsx:75`) | Status "Off". The switch's label is the agent's name |
| Unavailable | error, failed | agent status | Button: "Try again" |
| Sign in | Log in, Login | everywhere | Already consistent |
| custom agent | ACP agent | Settings → Agents (`agents-section.tsx:203`) | "Add any agent that supports the Agent Client Protocol." Spell out the name once and don't use the acronym |
| Install {agent} for Gui | Install Gui's copy | Settings → Agents, when the user's own agent is a version Gui can't use | Theirs stays as it is |
| this Mac | this computer | everywhere | "Versions stay on this Mac." |
| the Gui team | WIP | crash reports (`account-section.tsx:31`) | "…sends the error and the Gui and macOS versions to the Gui team." |

## Git words

| Use | Don't use | Note |
|---|---|---|
| branch | ref, HEAD | The toolbar shows it, read only. "Detached HEAD" → "No branch" |
| repository | repo | In sentences and labels ("GitHub repository"). A placeholder like `owner/repo` is fine |
