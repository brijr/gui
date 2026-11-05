# Using Gui

How Gui works from the user's side: opening projects, design mode, the chat, viewports, the terminal and canvases. The [README](../README.md) has the short version.

## Agents

The start screen and **Settings → Agents** show your agent's state with one next step: **Install** downloads Claude Code or Codex (other agents: opens their install page), and **Sign in** runs its login in Terminal (Claude Code and Codex sign in from Gui directly); Gui re-checks when you come back. Every installed agent is on by default; switch off the ones you don't use in **Settings → Agents** (⌘,). Any other [ACP](https://agentclientprotocol.com) agent can be added there too. Custom agents live in `agents.json` in Gui's app data folder, in the shape of Zed's `agent_servers` (a pasted `{ "agent_servers": { … } }` block works too); `command` is a name on your PATH or an absolute or `~/` path:

```json
{ "Amp": { "command": "amp-acp", "args": [], "env": {} } }
```

## Projects

Open a project folder (⌘O). Gui detects the package manager and `dev` script, asks before running it the first time (showing the script), starts it, and loads the URL it prints. For a fresh clone, Gui installs missing dependencies (in the same confirmation), asks which app to preview in a monorepo, and offers to create `.env.local` from `.env.example`. Opening an app's folder inside a monorepo (say `shape/website`) opens the monorepo with that app chosen. Each project opens in a tab of the window (⌘T for a new one; ⌘N still opens a new window), with its own preview, chat, dev server and agent; tabs in the background keep running, and the tab strip shows when one's agent is working, waiting for your answer, or has failed. Opening a project that's already open shows its tab. To open a project on launch: `GUI_OPEN=/path/to/project bun run dev`.

From a terminal, `gui` opens the current folder in the installed Gui and starts its dev server (`gui path/to/app` opens another folder). A folder that's already open shows its tab. `bun run install-app` installs the command at `/usr/local/bin/gui`, or choose **Gui → Install 'gui' Command…** when that folder needs an administrator password.

## Design mode and the chat

Design mode (⌘D, or the pointer button in the toolbar) outlines whatever is under the pointer, with its component and size. Click an element to pick it, or drag out an area to pick a screenshot of it; hold ⇧ to pick several (⇧-click a picked one to drop it), and Esc when you're done. The wheel scrolls the page while you pick. Everything picked goes to the agent with your next message, in order, each with its screenshot; an area also names the element around it and its source. In the composer, point at a pick to see it in the page, or remove it with its **×**. In the chat, the agent's name in the header switches agents (or starts a new chat). Each turn folds the agent's steps into one line ("6 steps · 12s") and, when it changed files, ends with the result: the picked element before and after, the files changed, and **Undo** (**Undo to here** on an older message, which asks first because it undoes the later ones too; ⌘Z undoes the last change only while the chat is showing). Paste or drop reference images ("make it look like this"); the agent sees them. Messages sent while the agent works wait in a queue above the composer and run in order (Stop pauses it; you can remove one or send the next now). The model button opens a searchable list of the agent's models, with its effort levels when it has them. **Auto** (on by default, per project) answers the agent's permission requests for you; switch a project to **Ask** with the chip or ⇧⌘A. A permission card waiting for you is answered with ⌘↩ (Allow) or ⌘⌫ (Don't allow), never with an "always". Desktop fills the canvas; Laptop (1440 × 900), Tablet (820 × 1180) and Mobile (390 × 844) show your app in a device frame at exactly that size, so you see what fits above the fold on each. On a smaller window the frame is drawn smaller (the label above it says how much) while the page still lays out at the device's size; the agent is told which viewport you're looking at. ⌘+ and ⌘− zoom: a device frame between 25% and the largest that fits (⌘0 fits it again), Desktop like a browser's page zoom (⌘0 is 100%, and the address bar shows the level otherwise); the page keeps its CSS size, and picking and the agent's screenshots work at any zoom. Focus mode (⌘\) hides everything but the preview until ⌘\ or Esc brings it all back. The camera button in the toolbar copies or saves a full-resolution screenshot of the preview (the visible area or the full page), or attaches it to the chat. The Record button beside it records only the preview, without audio, at up to 30 fps for up to 60 seconds. Stop attaches a playable clip to your next message. The agent receives timestamped overview frames and, when it supports Gui’s tools, can inspect exact captured frames or short animation ranges; agents without image support cannot see the clip. Recordings stay locally with chat history. The dot at the start of the address bar is the dev server's status: click it to restart or stop the server, show its logs, or open the app in your browser. If the server crashes, a bar under the preview offers its logs and a restart. The logs live in the drawer under the preview (⌘J), next to terminals: your own login shell at the project root, as in Terminal. The first ⌘J opens a terminal; after that ⌘J shows whichever tab you left the drawer on. **+** adds another terminal, its **×** (or Delete on its tab) ends it and everything it started, and `exit` ends the shell but keeps the terminal, with **Restart** for a new one. ⌘K clears a terminal and ⌘⌫ deletes the line you're typing; copy, paste and the app's shortcuts (⌘D, ⌘↩ for a waiting card) work as usual while one has the keyboard (⌘W still closes the project's tab). Each project's terminals are its own: they keep running in a tab in the background and come back with their output when you switch to it. Drag the floating chat by its header and let go: it settles into the nearest corner of the canvas, or flick it toward another corner and it lands there. Drag it to the window's left or right edge and the sidebar's place lights up there; let go and the panel grows into it, docked on that side. Pull the sidebar's header and it shrinks back into the floating panel under the pointer, to drop in a corner or dock on the other side; ⇧⌘D does the same from where the chat is. Drag any edge or corner of the chat panel to resize it (docked: its left edge); Gui remembers the size. Use your agent or terminal for source control. The toolbar shows the project's current branch, read only, so you notice when it changes.

## Variations

Pick an element and ask for options ("show me 15 ways to make this better"): the agent writes each version as real code in your project, behind a small switch, and a bar in the preview's bottom-left corner (right of the floating chat when it's there) flips through them in the live preview (**3 of 15 · Tighter hierarchy**), the original among them. ‹ › flip, as do ← and → in the bar; the page scrolls to the element when it isn't in view, and keeps the one showing when it reloads. **Use this** asks the agent to keep that version and remove the rest; × (or Esc in the bar) undoes the message that made them, asking first when later messages would go too. [Variations](variations.md) has the details.

## Canvases

**New canvas** on the start screen (⌥⌘N) opens a freeform board at once, with no folder, install or dev server: ask the agent for a page, or a few versions of one, and each lands as a frame you can move, resize, compare and name, like artboards in Figma. Each frame is a single-file HTML page. Scroll pans, ⌘-scroll or a pinch zooms, and dragging pans with the Hand tool (H, or hold Space; V goes back to Move), and the board's corner handle resizes a frame; drag across empty board (or ⇧-click) to select several, which the agent's next message is about. ⌥⌘D duplicates the selection, ⇧⌘E (or the toolbar's export button) exports it as PNGs at 2×, Delete deletes it, arrow keys nudge it, ⌘0 fits the board, and ⌘Z takes back your own board changes before the agent's turns. **+ Frame** adds a Desktop, Tablet or Mobile frame. **Sections** group frames under a name (⌥⌘G or right-click → Add Section, around what's selected): a section sizes itself to its frames, dragging its name moves them all, a frame dropped on it joins it and one dragged out leaves it, and Delete with the section picked removes only the section. The agent groups related frames into sections too. **Export** saves PNGs at 2×: a frame, the selection (⇧⌘E), a section, or the whole canvas (the canvas menu's Export All Frames…), with a folder per section when the frames span several. Double-click a frame (or press Return) to open it live in the preview: in the device viewport its size (or width) is, or else at exactly its own size, like a 1080 × 1080 post or a 300 × 250 ad, drawn smaller when the window can't fit it; the size menu lists that size above the devices, so you can try a device and come back. ⌘D opens the selected frame and starts picking in it. Live, picking (⌘D), viewports, screenshots and the agent's preview tools work as in a project; **Canvas** or Esc goes back. The agent can also screenshot any website ("make it feel like linear.app") to use as a reference, at a desktop or mobile width or as the whole page, and save it to the canvas's `assets/` to put it in a frame; it loads the site in a hidden window with its own cookies, apart from your previews, so it isn't signed in anywhere. Right-click a frame to rename, duplicate, delete, copy it as a PNG, export it as a PNG, copy or save its HTML, or **Turn into Project…**, which makes a Vite project of it where you choose and opens it in a new tab. Canvases are listed on the start screen and kept in Gui's data folder, with their chats, Undo, and the board's layout, across restarts.

## Keyboard shortcuts

Every shortcut is in the app's menus, and **Help → Keyboard Shortcuts** (⌘/) lists them all; toolbar and chat buttons name theirs in their tooltips. They're defined once, in `src/shared/shortcuts.ts`.

| Action | Shortcut |
| --- | --- |
| **App** | |
| Open Settings | ⌘, |
| Open a new window | ⌘N |
| Open a project folder | ⌘O |
| Open a new canvas to design on freely | ⌥⌘N |
| Close the window and its tabs | ⇧⌘W |
| Undo typing, or outside a text field the agent's last change | ⌘Z |
| Redo typing, or the agent's change you undid | ⇧⌘Z |
| Show the keyboard shortcuts | ⌘/ |
| Inspect Gui's own window | ⌥⌘J |
| **Preview** | |
| Edit the preview's address | ⇧⌘L |
| Reload the preview | ⌘R |
| Reload the preview, ignoring the cache | ⇧⌘R |
| Go back | ⌘[ |
| Go forward | ⌘] |
| Desktop: fill the window | ⌘1 |
| Laptop: 1440 × 900 | ⌘2 |
| Tablet: 820 × 1180 | ⌘3 |
| Mobile: 390 × 844 | ⌘4 |
| Zoom in: the page, or a device frame up to the size that fits | ⌘+ or ⌘= |
| Zoom out | ⌘− |
| Page at 100%, or a device frame back to fit | ⌘0 |
| Design mode: click an element or drag out an area to change (Esc when done) | ⌘D or ⇧⌘C |
| Copy, save or attach a screenshot | ⇧⌘S |
| Show only the preview (Esc exits) | ⌘\ |
| Inspect your app's page | ⌥⌘I |
| **Chat & agent** | |
| Show the chat and its message box; from there, hide it | ⌘L |
| Dock the chat beside the preview, or float it | ⇧⌘D |
| Choose the agent's model and effort | ⇧⌘M |
| Start a new chat | ⇧⌘K |
| Stop the agent | ⌘. |
| Auto or Ask for the agent's permission requests | ⇧⌘A |
| Allow what the agent's waiting to do | ⌘↩ |
| Don't allow what the agent's waiting to do | ⌘⌫ |
| **Terminal** | |
| Show or hide the terminal and the dev server's logs | ⌘J |
| Clear the terminal (in a terminal) | ⌘K |
| Delete the line you're typing (in a terminal) | ⌘⌫ |
| **Tabs** | |
| Open a new tab | ⌘T |
| Close the tab, stopping its agent and app | ⌘W |
| Show the previous tab | ⌃⇧⇥ or ⇧⌘[ |
| Show the next tab | ⌃⇥ or ⇧⌘] |

## GitHub

**Clone…** on the start screen (⇧⌘O) lists the connected GitHub repositories above an address field, or offers **Connect GitHub** when there's no connection yet. **Settings → GitHub** connects or disconnects GitHub and chooses repositories for the Gui GitHub App. The connection is only for cloning. Cloning by address works without a GitHub connection. The account service stores the GitHub profile and verified primary email, with an optional product-update preference.

This requires configuring and deploying the separate account service, registering a GitHub App, and building Gui with its service URL. See [account service setup](../accounts/README.md). Builds without a configured service retain local project access and explain that GitHub connections are unavailable.
