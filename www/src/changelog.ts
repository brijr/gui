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
