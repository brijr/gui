/**
 * Every Gui release, newest first: the /changelog page. Add an entry at the top for each
 * release (see .cursor/skills/release). `date` is the tag's date, as
 * `git log -1 --format=%ad --date=short v<version>` prints it.
 */
export interface Release {
  version: string
  date: string
  changes: string[]
}

export const releases: Release[] = [
  {
    version: '0.1.0-alpha.21',
    date: '2026-11-12',
    changes: [
      'Fix: a terminal with a lot of colorful output, like a long diff or an agent CLI, could stop showing anything new while its command kept running. Gui now catches it and redraws the terminal with nothing lost.',
      'Closed terminals give back their memory.',
    ],
  },
  {
    version: '0.1.0-alpha.20',
    date: '2026-11-11',
    changes: [
      'You can follow your agent as it uses your app or a website: its pointer glides to what it clicks, the page scrolls there smoothly, text types in, and scrolls slow to a stop. Clicks are quicker than before. With Reduce motion on, it all happens at once.',
      'Agents can play an animation in the preview and watch it frame by frame, to check the motion they built.',
      'Agents get a smaller, sharper set of Gui tools. They can wait for something to appear on the page and go back a page.',
      'Agents ask before they open a website, and their preview tools act only on your app, not on other local servers. Amp, fx, Kiro, OpenCode and Pi, whose own settings decide what they ask, aren’t offered websites at all.',
      'When your agent changes your dev script, Gui asks before running it, every time.',
      'Double-click text in Design mode to edit it in place. When Gui writes the change into your source, the chat shows it in one line with Undo. Outside Design mode, a double-click selects a word as usual.',
      'Design mode names elements by what they are (h1, button), and a pick’s thumbnail shows the whole element.',
      'When your app isn’t running, the preview says so: the last page dims under a Start dev server card, instead of looking live.',
      'Record asks once whether to record your voice too (⌥⌘R repeats your choice), so the microphone button is gone from the toolbar.',
      'The variations bar appears only once its version is on the page.',
      'A new project asks on its card, not in a pop-up: the button that starts it is your OK, what runs is one click away, and the same OK lets your agent work there.',
      'The start screen shows just your agent and its next step, with Open project always first. Settings → Agents marks your default in the list and checks agents as it opens.',
      'When your app stops, its card says why in the error’s own words.',
      'An update waits in a small button by the address bar (Restart to update), instead of a dialog in the middle of your work.',
      'When something goes wrong in a message, the chat says what in plain words, such as busy servers, a rate limit or no credit, and offers Retry.',
      'A card asking to edit a file shows the lines that would change. Cards ask with just Don’t allow and Allow, and answering one, or pressing Stop, keeps the keyboard in the message box.',
      'The chat shows one status line at a time, a finished plan folds to one line, and the minimized chat pill is gone (⌘B hides the chat). Chat position moved to Settings → Agents.',
      'Canvas frames stay sharp at 100% on Retina screens, and keep their names inside sections when you zoom out. A frame your agent is changing says Rendering… until its new preview is in.',
      'On a canvas, ⌘D duplicates and ⇧⌘Z redoes your own board changes, as in Figma.',
      'One way back: Undo on a message (Undo to here on an older one, Redo, ⌘Z). The Versions sheet is gone, and an undone message no longer offers Follow up.',
      'Fix: if the page reloaded while your agent took a screenshot, the preview could go blank or stay shrunk inside its device frame until you changed the size. It now comes back on its own, and the screenshot is taken again.',
    ],
  },
  {
    version: '0.1.0-alpha.19',
    date: '2026-11-10',
    changes: [
      'Subagents show in the chat. When Claude Code or Codex hands work to subagents, each one is its own line with what it’s doing now, and its own stop button. A finished one folds to one line; open it to see its task, its steps and its answer. When a subagent asks for approval, the card says which one.',
      'Gemini CLI is a built-in agent again. It works with Gemini Code Assist and paid Gemini API or Vertex AI keys; Google now sends free and Google AI Pro accounts to its Antigravity CLI instead.',
    ],
  },
  {
    version: '0.1.0-alpha.18',
    date: '2026-11-10',
    changes: [
      'Smaller updates: from the next update after this one, Gui downloads only the parts that changed instead of the whole app.',
      'While your agent fills an empty canvas, the canvas just says so. Before that, its starter ideas are tidier.',
    ],
  },
  {
    version: '0.1.0-alpha.17',
    date: '2026-11-10',
    changes: [
      'The canvas is drawn on the GPU. Zooming a large board is smoother, and the board gives memory back after you zoom out.',
      'Figma’s zoom keys work on the canvas: ⇧1 fits the board, ⇧2 zooms to the selection, ⇧0 goes to 100%, + and − zoom, and holding Z zooms where you click (⌥ zooms out) or to an area you drag.',
      'Copy and paste frames with ⌘C and ⌘V, on the same canvas or another one. ⌘X cuts them, and one ⌘Z undoes a paste.',
      'Find with ⌘F: in the preview, or in the terminal when you’re typing in it. ⌘G and ⇧⌘G step through the matches.',
      'File → Reopen Closed Tab (⇧⌘T) brings back the tab you closed last, with its chat.',
      'When the agent checks your page at a phone or tablet width, the preview resizes into that size and back, as if you had picked it, instead of jumping.',
      'OpenCode’s questions now show as choices in the chat instead of failing.',
      'Fixes: resizing the chat no longer makes its messages draw over each other, the canvas shows its focus ring when you reach it with the keyboard, a screen reader names each frame, and a canvas whose graphics stop says so instead of going blank.',
    ],
  },
  {
    version: '0.1.0-alpha.16',
    date: '2026-11-10',
    changes: [
      'Your agent sees your guides. While the rulers are on, each message says where they are, so “line this up with my guide” just works.',
      'Agents can check alignment against your guides: they find edges that are a few pixels off, fix them, and check again. They can also place guides to show you what lines up.',
      'Gui starts faster and does less in the background. The window paints sooner, a chat you can’t see stops animating, and a dev script that never opens a port is no longer checked every second and a half.',
      'Gui asks first in more cases: edits to more config and dependency files, and any file path that starts with ~. The prompt before a project’s script runs can no longer hide part of a long or padded script.',
      'Text you edit in the preview is handled more carefully. Gui writes the edit into your files itself only when it is plain text inside one element, and anything else goes to your agent. There, the old and new text are marked as coming from the page, so a page can’t slip in instructions as if they were yours.',
      'A new version is offered once, not every few hours. If a restart can’t install it, Gui says so.',
      'A chat reopened from the archive is no longer lost if you start a new chat right after. Settings → Chat position now moves the chat in projects that are already open. The message box says when a message couldn’t be sent.',
      'Fixes: a damaged recent-projects file no longer blanks the start screen, Undo works when a subfolder has a git repository of its own (it leaves that folder alone and says so), guides stay the same in two tabs of one project, and an agent switched off in Settings no longer says “checking”.',
    ],
  },
  {
    version: '0.1.0-alpha.15',
    date: '2026-11-09',
    changes: [
      'Rulers: press ⇧R, or click the ruler in the toolbar, to show rulers along the preview. Drag guides out of them. Guides snap to elements and are kept per project.',
      'Type / anywhere in a message to pick a command or skill. Skills now get the element you picked, your images and your recordings.',
      'In the / menu, OpenCode and fx list the skills they can use. Codex skills are inserted as $name.',
      'For agents Gui can’t make ask first (fx, Amp, OpenCode, Pi and Kiro), the chat says the agent’s own setting decides, instead of showing Ask.',
      'Reopened chats pick up where they left off without replaying the history, and Amp chats now resume after a restart.',
      'Codex errors show their real reason. Pi’s header no longer shows its thinking level as a mode. Gui finds Cursor’s CLI under its new name.',
    ],
  },
  {
    version: '0.1.0-alpha.14',
    date: '2026-11-09',
    changes: [
      'jcode is a built-in agent. Errors from some other agents now show their real message.',
      'Drag the floating chat to the window’s left or right edge to dock it as a sidebar. Pull the sidebar’s header to float it again. The chat changes shape smoothly either way.',
      'Your app shows as soon as its dev server is ready, and a canvas or project opened right after launch shows at once.',
      'Gui uses less memory: zoomed out, a canvas shows small thumbnails, and closing a project frees its terminals and dev server at once.',
    ],
  },
  {
    version: '0.1.0-alpha.13',
    date: '2026-11-04',
    changes: ['The same app as 0.1.0-alpha.12, published again.'],
  },
  {
    version: '0.1.0-alpha.12',
    date: '2026-11-04',
    changes: [
      'Variations: in a project, select an element and ask for a few versions of it. A bar on the page goes through them. Keep one, or discard them all.',
      'Select Element is now called Design mode (⌘D).',
      'New Canvas is in the project menu.',
      'When you click the page, the floating chat hides to its button, unless you are writing a message.',
      'Canvases are more reliable: Undo works with a frame open, moving and resizing frames no longer fights the agent, and deleting a canvas also deletes its chat and history.',
      'Canvas frames open at their own size, for example 1080 × 1080 or 300 × 250.',
      'Open canvas frames cannot read the cookies of your local apps.',
      'Cleaner edges in dark mode, and smoother motion across the app.',
    ],
  },
  {
    version: '0.1.0-alpha.11',
    date: '2026-11-02',
    changes: [
      'The model menu for fx lists its models, grouped by provider.',
      'The agent in use shows one status, and does not repeat how to sign in next to its Sign in button.',
      'Icons are all one size and line up with their labels.',
    ],
  },
  {
    version: '0.1.0-alpha.10',
    date: '2026-11-01',
    changes: [
      'fx, from Vercel Labs, is a built-in agent.',
      'The agent in use says Ready once, with its install and version under its name.',
      'The GitHub mark sits next to Clone… and Connect GitHub.',
    ],
  },
  {
    version: '0.1.0-alpha.9',
    date: '2026-10-30',
    changes: [
      'Terminals that you cannot see stay idle, so Gui does less work in the background.',
      'The keyboard stays where it was after chat actions. Hiding the terminal while you type in it moves the keyboard to the page.',
      'Opening a project is more reliable, and Settings opens on the correct page.',
      'New canvas frames glide into view.',
    ],
  },
  {
    version: '0.1.0-alpha.8',
    date: '2026-10-30',
    changes: [
      'Gui no longer writes to your git repository. It does not make branches, commits, pushes or pull requests. Ask your agent, or use the terminal. The toolbar still shows the current branch.',
      'The agent can open a website in the preview and use it like a person. While it does, your clicks wait, and the website cannot send forms.',
      'A quieter window: the floating chat is only its message box until you need the conversation, and the toolbar has one size menu and shows shortcuts in tooltips.',
      'The terminal draws with Ghostty’s engine.',
      'F6 moves the keyboard between the toolbar, the page and the chat. Screen readers hear when the agent finishes or needs permission.',
      'Gui finds your app in more projects, keeps dependencies installed, and asks again when the start script changes.',
      'Chat replies no longer flash as plain text while they load. Backspace on a tab no longer closes the project.',
    ],
  },
  {
    version: '0.1.0-alpha.7',
    date: '2026-10-26',
    changes: [
      'Opening a project on main asks where to work: on main, on a new branch, or in a new worktree with its own tab.',
      'The toolbar shows your branch, with switching and new branches one click away.',
      'Installing the gui command also teaches your coding agents to open projects in Gui.',
      'The first window opens sooner, and closing a tab or quitting no longer stalls Gui.',
      'Recordings scrub smoothly and no longer stay on “Transcribing…”.',
      'Capturing a website on a canvas no longer freezes Gui.',
      'Menus say what they will do, such as Show Chat or Hide Chat.',
    ],
  },
  {
    version: '0.1.0-alpha.6',
    date: '2026-10-23',
    changes: [
      'Narrated recordings: talk and point while you record. The agent gets what you said and where the pointer was.',
      'The microphone sits next to Record and shows whether narration is on.',
      'The chat sidebar slides in and out, and the toolbar moves with it.',
      'Long permission options wrap inside their buttons.',
    ],
  },
  {
    version: '0.1.0-alpha.4',
    date: '2026-10-17',
    changes: [
      'On a canvas, the agent can take screenshots of websites to use as a reference.',
      'Website screenshots cannot read your clipboard or reach your Mac or your local network.',
      'Fixes to the canvas board, safer Undo, and smoother panning.',
    ],
  },
  {
    version: '0.1.0-alpha.3',
    date: '2026-10-16',
    changes: [
      'You can dismiss the errors bar under the preview.',
      'Reopening a chat no longer stacks its messages on top of each other.',
    ],
  },
  {
    version: '0.1.0-alpha.2',
    date: '2026-10-15',
    changes: [
      'Gui sends crash reports, and the Help menu has Contact Support.',
      'Gui needs macOS 13 or later.',
      'Before the agent edits main, Gui offers to make a branch.',
      'The download is signed, so macOS opens it without a warning.',
    ],
  },
  {
    version: '0.1.0-alpha.1',
    date: '2026-10-14',
    changes: [
      'The first alpha. Gui runs your dev server, shows your app, and puts your coding agent on top of it.',
      'Select elements or areas of the page and tell the agent what to change.',
      'Undo any change, or go back to an earlier message.',
      'Desktop, Laptop, Tablet and Mobile sizes. The agent knows which one you look at.',
      'Canvases: design HTML frames on a board, group them in sections, and export them as images.',
      'Record the page, take screenshots, and paste reference images into the chat.',
      'Terminals, the dev server’s logs, and a tab for each project.',
      'Gui updates itself.',
    ],
  },
]
