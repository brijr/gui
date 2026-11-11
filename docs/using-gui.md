# Using Gui

How Gui works from the user's side: opening projects, design mode, the chat, viewports, the terminal and canvases. The [README](../README.md) has the short version.

## Agents

The start screen and **Settings → Agents** show your agent's state with one next step: **Install** downloads Claude Code or Codex (other agents: opens their install page), and **Sign in** runs its login in Terminal (Claude Code and Codex sign in from Gui directly); Gui re-checks when you come back. Every installed agent is on by default; switch off the ones you don't use in **Settings → Agents** (⌘,). Any other [ACP](https://agentclientprotocol.com) agent can be added there too. Custom agents live in `agents.json` in Gui's app data folder, in the shape of Zed's `agent_servers` (a pasted `{ "agent_servers": { … } }` block works too); `command` is a name on your PATH or an absolute or `~/` path:

```json
{ "My Agent": { "command": "my-agent", "args": ["--acp"], "env": {} } }
```

## Projects

Open a project folder (⌘O). Gui detects the package manager and `dev` script, asks before running it the first time (showing the script) and again whenever the script changes, also when your agent changed it, then starts it and loads the URL it prints. For a fresh clone, Gui installs missing dependencies (in the same confirmation), asks which app to preview in a monorepo, and offers to create `.env.local` from `.env.example`. Opening an app's folder inside a monorepo (say `shape/website`) opens the monorepo with that app chosen. Each project opens in a tab of the window (⌘T for a new one; ⌘N still opens a new window), with its own preview, chat, dev server and agent; tabs in the background keep running, and the tab strip shows when one's agent is working, waiting for your answer, or has failed. A project that's already open shows its tab when you open it from the `gui` command, the Dock or File → Open Recent. ⌘O and the start screen's recent projects open it again in another tab, so a monorepo can run two of its apps side by side. To open a project on launch: `GUI_OPEN=/path/to/project bun run dev`.

From a terminal, `gui` opens the current folder in the installed Gui and starts its dev server (`gui path/to/app` opens another folder). A folder that's already open shows its tab. `bun run install-app` installs the command at `/usr/local/bin/gui`, or choose **Gui → Install 'gui' Command…** when that folder needs an administrator password.

## Design mode and the chat

Design mode (⌘D, or the pointer button in the toolbar) outlines whatever is under the pointer, naming what it is (h1, button) and then, quieter, its component and size. Click an element to pick it, or drag out an area to pick a screenshot of it; hold ⇧ to pick several (⇧-click a picked one to drop it), and Esc when you're done. The wheel scrolls the page while you pick. Everything picked goes to the agent with your next message, in order, each with its screenshot; an area also names the element around it and its source. In the composer, point at a pick to see it in the page, or remove it with its **×**. In design mode, double-click text to edit it in place (a double-click outside design mode is your app's, and selects a word): Return or clicking away keeps it, Esc puts it back, as the hint beside it says. Gui writes the change into your source when the text is there plainly, and the chat shows it in one line (“Ship faster” → “Ship today” · App.tsx) with **Undo**; otherwise it asks the agent to make it. In the chat, the agent's name in the header switches agents (or starts a new chat). Each turn folds the agent's steps into one line ("6 steps · 12s") and, when it changed files, ends with the result: the picked element before and after, the files changed, and **Undo** (**Undo to here** on an older message, which asks first because it undoes the later ones too; ⌘Z undoes the last change only while the chat is showing). Paste or drop reference images ("make it look like this"); the agent sees them. Messages sent while the agent works wait in a queue above the composer and run in order (Stop pauses it; you can remove one or send the next now). The model button opens a searchable list of the agent's models, with its effort levels when it has them. **Auto** (on by default, per project) answers the agent's permission requests for you; switch a project to **Ask** with the shield button in the composer or ⇧⌘A. Amp, fx, Kiro, OpenCode and Pi have no mode Gui can switch to ask first, so their own settings decide what they ask about, and the composer says "Amp's own setting" (or the agent's name) in the button's place. A permission card waiting for you is answered with ⌘↩ (Allow) or ⌘⌫ (Don't allow), never with an "always". Desktop fills the canvas; Laptop (1440 × 900), Tablet (820 × 1180) and Mobile (390 × 844) show your app in a device frame at exactly that size, so you see what fits above the fold on each. On a smaller window the frame is drawn smaller (the label above it says how much) while the page still lays out at the device's size; the agent is told which viewport you're looking at. ⌘+ and ⌘− zoom: a device frame between 25% and the largest that fits (⌘0 fits it again), Desktop like a browser's page zoom (⌘0 is 100%, and the address bar shows the level otherwise); the page keeps its CSS size, and picking and the agent's screenshots work at any zoom. Focus mode (⌘\) hides everything but the preview until ⌘\ or Esc brings it all back. The camera button in the toolbar copies or saves a full-resolution screenshot of the preview (the visible area or the full page), or attaches it to the chat. The Record button beside it records only the preview: choose **Record** for up to 60 seconds, keeping frames for the agent at up to 30 fps, or **Record with Voice** to talk and point while you record (⌥⌘R starts whichever you chose last). With your voice, the mic's level shows beside the timer, and Gui asks macOS for the microphone, records your voice into the clip, and transcribes it on this Mac (macOS 26 or later); a narrated clip runs up to 3 minutes and keeps frames at up to 10 fps. Stop attaches a playable clip to your next message; with a narrated one, Send waits until it's transcribed. The agent receives timestamped overview frames and a timeline of what happened in the page, and for a narrated clip what you said, with where the pointer was as you said it. When it supports Gui’s tools, it can inspect exact captured frames or short animation ranges; agents without image support cannot see the clip, and work from the timeline and what you said. Recordings stay locally with chat history. The agent can also play an animation in your app itself and watch it: it gets a strip of timed frames and a list of the animations that ran, slowed down or with reduced motion if it asks. The dot at the start of the address bar is the dev server's status: click it to restart or stop the server, show its logs, or open the app in your browser. Once the server stops (Stop, a crash, or something outside Gui), its last page stays dimmed behind a card that says so and starts it again, so it never passes for live. The logs live in the drawer under the preview (⌘J), next to terminals: your own login shell at the project root, as in Terminal. The first ⌘J opens a terminal; after that ⌘J shows whichever tab you left the drawer on. **+** adds another terminal, its **×** (or Delete on its tab) ends it and everything it started, and `exit` ends the shell but keeps the terminal, with **Restart** for a new one. ⌘K clears a terminal and ⌘⌫ deletes the line you're typing; copy, paste and the app's shortcuts (⌘D, ⌘↩ for a waiting card) work as usual while one has the keyboard (⌘W still closes the project's tab). Each project's terminals are its own: they keep running in a tab in the background and come back with their output when you switch to it. Drag the floating chat by its header and let go: it settles into the nearest corner of the canvas, or flick it toward another corner and it lands there. Drag it to the window's left or right edge and the sidebar's place lights up there; let go and the panel grows into it, docked on that side. Pull the sidebar's header and it shrinks back into the floating panel under the pointer, to drop in a corner or dock on the other side; ⇧⌘D does the same from where the chat is. Drag any edge or corner of the chat panel to resize it (docked: its left edge); Gui remembers the size. Use your agent or terminal for source control. The toolbar shows the project's current branch, read only, so you notice when it changes.

## Variations

Pick an element and ask for options ("show me 15 ways to make this better"): the agent writes each version as real code in your project, behind a small switch, and a bar in the preview's bottom-left corner (right of the floating chat when it's there) flips through them in the live preview (**3 of 15 · Tighter hierarchy**), the original among them. ‹ › flip, as do ← and → in the bar; the page scrolls to the element when it isn't in view, and keeps the one showing when it reloads. **Use this** asks the agent to keep that version and remove the rest; × (or Esc in the bar) undoes the message that made them, asking first when later messages would go too. [Variations](variations.md) has the details.

## Rulers and guides

The ruler button in the toolbar (⇧R, or View → Rulers) shows rulers along the top and left of the preview, in your page's CSS pixels. Drag out of a ruler to make a guide: the top ruler gives a horizontal one, the left ruler a vertical one. Drag a guide to move it, or back onto its ruler to remove it. While you drag, a guide snaps to the nearest edge or middle of the element under the pointer. Guides stay with the page as it scrolls and are kept per project (up to 50). They are drawn over the preview, not in your page, so they don't show in screenshots or recordings. ⇧R works whenever you aren't typing in a field. Rulers are for projects; a canvas has none.

While the rulers are on, the agent sees your guides with each message, so "line this up with the guide" works. It can also check alignment against them: it reads which element edges sit within 8 pixels of a guide without being on it, and it can add or remove guides to show you what lines up.

## Canvases

**New canvas** on the start screen (⌥⌘N) opens a freeform board at once, with no folder, install or dev server: ask the agent for a page, or a few versions of one, and each lands as a frame you can move, resize, compare and name, like artboards in Figma. Each frame is a single-file HTML page. Scroll pans, ⌘-scroll or a pinch zooms, and dragging pans with the Hand tool (H, or hold Space; V goes back to Move), and the board's corner handle resizes a frame; drag across empty board (or ⇧-click) to select several, which the agent's next message is about. ⌘D duplicates the selection, as in Figma, ⌘C and ⌘V copy and paste it onto this canvas or another (⌘X cuts), ⇧⌘E (or the toolbar's export button) exports it as PNGs at 2×, Delete deletes it, arrow keys nudge it, ⇧1 (or ⌘0) fits the board, ⇧2 zooms to the selection, ⇧0 goes to 100%, + and − zoom, holding Z makes a click zoom in (⌥-click out) and a drag zoom to that area, ⌘Z takes back your own board changes before the agent's turns, and ⇧⌘Z puts them back (until you or the agent change the board again). **+ Frame** adds a Desktop, Tablet or Mobile frame. **Sections** group frames under a name (⌥⌘G or right-click → Add Section, around what's selected): a section sizes itself to its frames, dragging its name moves them all, a frame dropped on it joins it and one dragged out leaves it, and Delete with the section picked removes only the section. The agent groups related frames into sections too. **Export** saves PNGs at 2×: a frame, the selection (⇧⌘E), a section, or the whole canvas (the canvas menu's Export All Frames…), with a folder per section when the frames span several. Double-click a frame (or press Return) to open it live in the preview: in the device viewport its size (or width) is, or else at exactly its own size, like a 1080 × 1080 post or a 300 × 250 ad, drawn smaller when the window can't fit it; the size menu lists that size above the devices, so you can try a device and come back. The toolbar's Design mode button opens the selected frame and starts picking in it. Live, picking (⌘D), viewports, screenshots and the agent's preview tools work as in a project; **Canvas** or Esc goes back. The agent can also screenshot any website ("make it feel like linear.app") to use as a reference, at a desktop or mobile width or as the whole page, and save it to the canvas's `assets/` to put it in a frame; it loads the site in a hidden window with its own cookies, apart from your previews, so it isn't signed in anywhere. Right-click a frame to rename, duplicate, delete, copy it as a PNG, export it as a PNG, copy or save its HTML, or **Turn into Project…**, which makes a Vite project of it where you choose and opens it in a new tab. Canvases are listed on the start screen and kept in Gui's data folder, with their chats, Undo, and the board's layout, across restarts.

## Keyboard shortcuts

Every shortcut is in the app's menus, and **Help → Keyboard Shortcuts** (⌘/) lists them all; toolbar and chat buttons name theirs in their tooltips. They're defined once, in `src/shared/shortcuts.ts`.

| Action | Shortcut |
| --- | --- |
| **App** | |
| Open Settings | ⌘, |
| Open a new window | ⌘N |
| Open a project folder | ⌘O |
| Start a project in a new, empty folder | ⇧⌘N |
| Open a new canvas to design on freely | ⌥⌘N |
| Copy a GitHub repository to your Mac and open it | ⇧⌘O |
| Close the window and its tabs | ⇧⌘W |
| Undo typing, or with the chat showing, the agent's last change | ⌘Z |
| Redo typing, or with the chat showing, the agent's change you undid | ⇧⌘Z |
| Show the keyboard shortcuts | ⌘/ |
| Find text in the preview, or in the terminal you're typing in | ⌘F |
| Show the next match | ⌘G |
| Show the previous match | ⇧⌘G |
| Close the find bar (in it) | Esc |
| Move the keyboard to the next pane: toolbar, preview, chat | F6 |
| Move the keyboard to the previous pane | ⇧F6 |
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
| Show or hide rulers; drag a guide out of one, back onto it to remove | ⇧R |
| Copy, save or attach a screenshot | ⇧⌘S |
| Start or stop a video of the preview, to attach to a message | ⌥⌘R |
| Show only the preview (Esc exits) | ⌘\ |
| Inspect your app's page | ⌥⌘I |
| **Chat & agent** | |
| Show or hide the chat | ⌘B |
| Put the cursor in the chat's message box, showing the chat if it's hidden | ⌘L |
| Send the message, or queue it while the agent works (in the message box) | ↩ |
| Start a new line in the message (in the message box) | ⇧↩ |
| Show the chat as a sidebar, or float it over the preview | ⇧⌘D |
| Move the chat into a window of its own, or back into this one | ⌥⌘L |
| Choose the agent's model and effort | ⇧⌘M |
| Start a new chat | ⇧⌘K |
| Stop the agent | ⌘. |
| Auto or Ask for the agent's permission requests | ⇧⌘A |
| Allow what the agent's waiting to do | ⌘↩ |
| Don't allow what the agent's waiting to do | ⌘⌫ |
| **Canvas** | |
| Hand tool: drag to pan | H |
| Move tool: select and drag frames | V |
| Zoom tool while held: click to zoom in, ⌥-click to zoom out, drag to zoom to an area | Z |
| Zoom the canvas in | + or = or ⌘+ |
| Zoom the canvas out | − or ⌘− |
| Zoom to 100% | ⇧0 |
| Zoom to fit every frame | ⇧1 or ⌘0 |
| Zoom to the selected frames, or the section picked by its name | ⇧2 |
| Select the next section or frame, or the previous one | ⇥ or ⇧⇥ |
| Open the selected frame | ↩ |
| Rename the selected frame or section | F2 |
| Show the selected frame's or section's menu | ⇧F10 |
| Move the selected frames a pixel | ← → ↑ ↓ |
| Move the selected frames 10 pixels | ⇧ with ← → ↑ ↓ |
| Select every frame | ⌘A |
| Group the selected frames in a section | ⌥⌘G |
| Duplicate the selected frames | ⌘D |
| Copy the selected frames, to paste on any canvas | ⌘C |
| Cut the selected frames | ⌘X |
| Paste copied frames onto this canvas | ⌘V |
| Export the selected frames as PNG | ⇧⌘E |
| Delete the selected frames, or the section picked by its name | ⌫ or ⌦ |
| **Terminal** | |
| Show or hide the terminal and the dev server's logs | ⌘J |
| Clear the terminal (in a terminal) | ⌘K |
| Delete the line you're typing (in a terminal) | ⌘⌫ |
| **Tabs** | |
| Open a new tab | ⌘T |
| Close the tab, stopping its agent and app | ⌘W |
| Open the tab you closed last again, with its chat | ⇧⌘T |
| Show the previous tab | ⌃⇧⇥ or ⇧⌘[ |
| Show the next tab | ⌃⇥ or ⇧⌘] |

## GitHub

**Clone…** on the start screen (⇧⌘O) lists the connected GitHub repositories above an address field, or offers **Connect GitHub** when there's no connection yet. **Settings → GitHub** connects or disconnects GitHub and chooses repositories for the Gui GitHub App. The connection is only for cloning. Cloning by address works without a GitHub connection. The account service stores the GitHub profile and verified primary email, with an optional product-update preference.

This requires configuring and deploying the separate account service, registering a GitHub App, and building Gui with its service URL. See [account service setup](../accounts/README.md). Builds without a configured service retain local project access and explain that GitHub connections are unavailable.
