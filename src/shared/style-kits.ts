// Style kits: a starting look for an empty canvas. A kit becomes a stylesheet of CSS
// variables plus a brand.md that tells the agent to use them, and one sample frame.

export type StyleKitId = 'neutral' | 'editorial' | 'soft' | 'mono'

export interface StyleKit {
  id: StyleKitId
  name: string
  blurb: string
  light: Record<string, string>
  dark: Record<string, string>
  rules: string[]
}

export const KIT_TOKENS: readonly string[] = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius',
  '--font-sans',
  '--font-heading',
  '--font-mono',
]

const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const SYSTEM = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const SERIF = 'ui-serif, Georgia, "Times New Roman", serif'
const ROUNDED = 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", sans-serif'

interface Palette {
  background: string
  foreground: string
  card: string
  primary: string
  primaryForeground: string
  secondary: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  border: string
}

interface Shape {
  radius: string
  sans: string
  heading: string
  mono: string
}

// The paired foregrounds, input and ring follow from the palette, so a kit only states what differs.
function tokens(p: Palette, s: Shape): Record<string, string> {
  return {
    '--background': p.background,
    '--foreground': p.foreground,
    '--card': p.card,
    '--card-foreground': p.foreground,
    '--primary': p.primary,
    '--primary-foreground': p.primaryForeground,
    '--secondary': p.secondary,
    '--secondary-foreground': p.foreground,
    '--muted': p.muted,
    '--muted-foreground': p.mutedForeground,
    '--accent': p.accent,
    '--accent-foreground': p.accentForeground,
    '--border': p.border,
    '--input': p.border,
    '--ring': p.primary,
    '--radius': s.radius,
    '--font-sans': s.sans,
    '--font-heading': s.heading,
    '--font-mono': s.mono,
  }
}

export const STYLE_KITS: readonly StyleKit[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    blurb: 'Zinc grays, a near-black primary, thin borders.',
    light: tokens(
      {
        background: '#ffffff',
        foreground: '#09090b',
        card: '#ffffff',
        primary: '#18181b',
        primaryForeground: '#fafafa',
        secondary: '#f4f4f5',
        muted: '#f4f4f5',
        mutedForeground: '#71717a',
        accent: '#e4e4e7',
        accentForeground: '#18181b',
        border: '#e4e4e7',
      },
      { radius: '0.5rem', sans: SYSTEM, heading: SYSTEM, mono: MONO_STACK },
    ),
    dark: tokens(
      {
        background: '#09090b',
        foreground: '#fafafa',
        card: '#18181b',
        primary: '#fafafa',
        primaryForeground: '#18181b',
        secondary: '#27272a',
        muted: '#27272a',
        mutedForeground: '#a1a1aa',
        accent: '#3f3f46',
        accentForeground: '#fafafa',
        border: '#27272a',
      },
      { radius: '0.5rem', sans: SYSTEM, heading: SYSTEM, mono: MONO_STACK },
    ),
    rules: [
      'Keep it quiet: zinc grays, one near-black primary, no extra accent colors.',
      'Borders are 1px and light. Prefer a border over a shadow.',
      'Use the system font for headings and body, with medium weight for headings.',
      'Round corners with var(--radius).',
    ],
  },
  {
    id: 'editorial',
    name: 'Editorial',
    blurb: 'Warm paper and ink, serif headings, a red accent.',
    light: tokens(
      {
        background: '#faf6ee',
        foreground: '#1f1a14',
        card: '#fffdf8',
        primary: '#1f1a14',
        primaryForeground: '#faf6ee',
        secondary: '#efe8d8',
        muted: '#efe8d8',
        mutedForeground: '#6b6256',
        accent: '#b3261e',
        accentForeground: '#fffdf8',
        border: '#d9cfbb',
      },
      { radius: '0', sans: SYSTEM, heading: SERIF, mono: MONO_STACK },
    ),
    dark: tokens(
      {
        background: '#17130e',
        foreground: '#f1e9d8',
        card: '#201b14',
        primary: '#f1e9d8',
        primaryForeground: '#17130e',
        secondary: '#2a241b',
        muted: '#2a241b',
        mutedForeground: '#a89d8a',
        accent: '#e0574d',
        accentForeground: '#17130e',
        border: '#3a3326',
      },
      { radius: '0', sans: SYSTEM, heading: SERIF, mono: MONO_STACK },
    ),
    rules: [
      'Set headings in the serif (var(--font-heading)) and body text in the sans.',
      'Use red (var(--accent)) sparingly: a rule, a link, a single highlight per view.',
      'Corners are square. Use thin rules instead of boxes to separate content.',
      'Give text generous line height (1.6 or more) and wide margins.',
    ],
  },
  {
    id: 'soft',
    name: 'Soft',
    blurb: 'Rounded corners, a pastel violet primary, gentle shadows.',
    light: tokens(
      {
        background: '#fbfaff',
        foreground: '#2a2640',
        card: '#ffffff',
        primary: '#6d5ce6',
        primaryForeground: '#ffffff',
        secondary: '#efecff',
        muted: '#f3f1fb',
        mutedForeground: '#6f6a8c',
        accent: '#d9d3ff',
        accentForeground: '#2a2640',
        border: '#e6e2f5',
      },
      { radius: '1rem', sans: ROUNDED, heading: ROUNDED, mono: MONO_STACK },
    ),
    dark: tokens(
      {
        background: '#171526',
        foreground: '#ece9ff',
        card: '#201d33',
        primary: '#a99dfb',
        primaryForeground: '#171526',
        secondary: '#2b2745',
        muted: '#25213b',
        mutedForeground: '#a39dc4',
        accent: '#3a3463',
        accentForeground: '#ece9ff',
        border: '#312c4f',
      },
      { radius: '1rem', sans: ROUNDED, heading: ROUNDED, mono: MONO_STACK },
    ),
    rules: [
      'Round everything with var(--radius). Pills for buttons and badges.',
      'Use soft shadows (large blur, low opacity) instead of hard borders.',
      'Stay in pastel violet and its tints. Keep contrast readable on the primary.',
      'Be generous with padding.',
    ],
  },
  {
    id: 'mono',
    name: 'Mono',
    blurb: 'Monospace everywhere, black and white, a lime accent.',
    light: tokens(
      {
        background: '#ffffff',
        foreground: '#000000',
        card: '#ffffff',
        primary: '#000000',
        primaryForeground: '#ffffff',
        secondary: '#f2f2f2',
        muted: '#f2f2f2',
        mutedForeground: '#555555',
        accent: '#b6f23a',
        accentForeground: '#000000',
        border: '#000000',
      },
      { radius: '0', sans: MONO_STACK, heading: MONO_STACK, mono: MONO_STACK },
    ),
    dark: tokens(
      {
        background: '#000000',
        foreground: '#ffffff',
        card: '#0a0a0a',
        primary: '#ffffff',
        primaryForeground: '#000000',
        secondary: '#1a1a1a',
        muted: '#1a1a1a',
        mutedForeground: '#a3a3a3',
        accent: '#b6f23a',
        accentForeground: '#000000',
        border: '#ffffff',
      },
      { radius: '0', sans: MONO_STACK, heading: MONO_STACK, mono: MONO_STACK },
    ),
    rules: [
      'Everything is monospace, headings included.',
      'Black and white only, plus lime (var(--accent)) for one highlight at a time.',
      'Borders are 1px solid var(--border). Corners are square. No shadows.',
      'Prefer uppercase for small labels.',
    ],
  },
]

export function isStyleKitId(value: unknown): value is StyleKitId {
  return STYLE_KITS.some((kit) => kit.id === value)
}

export function kitStylesheetName(kit: StyleKit): string {
  return `kit-${kit.id}.css`
}

function block(selector: string, scheme: string, values: Record<string, string>): string {
  const lines = [
    `  color-scheme: ${scheme};`,
    ...KIT_TOKENS.map((token) => `  ${token}: ${values[token]};`),
  ]
  return `${selector} {\n${lines.join('\n')}\n}\n`
}

export function kitCss(kit: StyleKit): string {
  return [
    block(':root', 'light', kit.light),
    block('.dark', 'dark', kit.dark),
    'body { margin: 0; background: var(--background); color: var(--foreground); font-family: var(--font-sans); }',
    'h1, h2, h3 { font-family: var(--font-heading); }',
    '',
  ].join('\n')
}

export function kitBrand(kit: StyleKit): string {
  const sheet = kitStylesheetName(kit)
  return [
    `# ${kit.name} style kit`,
    '',
    kit.blurb,
    '',
    '## Use the kit',
    '',
    `- Link the stylesheet in every frame: \`<link rel="stylesheet" href="../assets/${sheet}">\``,
    '- Take colors, radius and fonts from the variables, such as var(--primary), var(--radius) and var(--font-heading). Never write raw values.',
    '- Add class="dark" to <html> for the dark theme.',
    `- To change the kit, edit ${sheet}. Every frame follows.`,
    '',
    '## Rules',
    '',
    ...kit.rules.map((rule) => `- ${rule}`),
    '',
  ].join('\n')
}

// Every color, radius and font is a variable, so editing the stylesheet restyles this frame too.
export function kitFrameHtml(kit: StyleKit): string {
  const swatches = ['primary', 'secondary', 'muted', 'accent', 'border']
    .map((name) => `<div class="swatch" style="background: var(--${name})" title="${name}"></div>`)
    .join('\n        ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${kit.name} kit</title>
    <link rel="stylesheet" href="../assets/${kitStylesheetName(kit)}">
    <style>
      main { max-width: 720px; margin: 0 auto; padding: 64px 32px; display: grid; gap: 32px; }
      p { line-height: 1.6; margin: 0; }
      .muted { color: var(--muted-foreground); }
      .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      button, input { font: inherit; border-radius: var(--radius); padding: 10px 16px; }
      .primary { background: var(--primary); color: var(--primary-foreground); border: 1px solid var(--primary); }
      .secondary { background: var(--secondary); color: var(--secondary-foreground); border: 1px solid var(--secondary); }
      .outline { background: transparent; color: var(--foreground); border: 1px solid var(--border); }
      input { background: var(--background); color: var(--foreground); border: 1px solid var(--input); min-width: 240px; }
      input:focus { outline: 2px solid var(--ring); outline-offset: 1px; }
      .card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; display: grid; gap: 8px; }
      .badge { background: var(--accent); color: var(--accent-foreground); border-radius: var(--radius); padding: 2px 10px; font-size: 12px; }
      .swatch { width: 56px; height: 56px; border: 1px solid var(--border); border-radius: var(--radius); }
    </style>
  </head>
  <body>
    <main>
      <h1>${kit.name} kit</h1>
      <p class="muted">${kit.blurb} Ask for a screen and it starts from these variables.</p>
      <div class="row">
        <button class="primary">Primary</button>
        <button class="secondary">Secondary</button>
        <button class="outline">Outline</button>
      </div>
      <div class="row"><input placeholder="Type here" aria-label="Sample input"></div>
      <div class="card">
        <div class="row"><h3>A card</h3><span class="badge">New</span></div>
        <p>Body text sits on the card color, in the kit's body font.</p>
      </div>
      <div class="row">
        ${swatches}
      </div>
    </main>
  </body>
</html>
`
}
