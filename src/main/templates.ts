import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectTemplate } from '../shared/types'

/**
 * The files a new project starts with: a small Vite, React and Tailwind app that runs as
 * soon as its packages are installed, so the preview shows something to point at and the
 * agent has a known setup to build on. Blank has none: the agent picks the stack.
 */
type Files = Record<string, string>

const PACKAGE_JSON = `${JSON.stringify(
  {
    private: true,
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    // Vite's own: on an older Node.js, Gui runs the project with its own (node-version.ts).
    engines: { node: '^20.19.0 || >=22.12.0' },
    dependencies: {
      '@fontsource-variable/inter-tight': '^5.3.0',
      react: '^19.3.0',
      'react-dom': '^19.3.0',
    },
    devDependencies: {
      '@tailwindcss/vite': '^4.3.3',
      '@vitejs/plugin-react': '^6.1.2',
      tailwindcss: '^4.3.3',
      vite: '^8.3.3',
    },
  },
  null,
  2,
)}\n`

const VITE_CONFIG = `import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
`

// The font comes from a package, so it is there offline once installed and the same on Mac and
// Linux. Its stylesheet splits the font by script; the browser loads only the Latin file for
// English text.
const MAIN = `import '@fontsource-variable/inter-tight'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`

/**
 * The look of usegui.com: one light typeface, near-black on near-white, a muted grey and
 * hairline rules, and nothing else. Named tokens, so the agent changes a colour in one place.
 */
const CSS = `@import 'tailwindcss';

@theme {
  --color-background: #fafafa;
  --color-foreground: #111;
  --color-muted: #6b6b6b;
  --color-rule: rgb(0 0 0 / 0.1);

  --font-sans: 'Inter Tight Variable', ui-sans-serif, system-ui, sans-serif;

  --text-title: clamp(1.75rem, 1.2rem + 2vw, 2.5rem);
  --text-title--line-height: 1.08;
  --text-title--letter-spacing: -0.035em;
  --text-title--font-weight: 250;
  --text-section: 1.5rem;
  --text-section--line-height: 1.15;
  --text-section--letter-spacing: -0.03em;

  --container-column: 40rem;
  --container-page: 68rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-background: #161616;
    --color-foreground: #f2f2f2;
    --color-muted: #b3b3b3;
    --color-rule: rgb(255 255 255 / 0.12);
  }
}

@layer base {
  html {
    color-scheme: light dark;
    -webkit-text-size-adjust: 100%;
  }
  body {
    background: var(--color-background);
    color: var(--color-foreground);
    font-family: var(--font-sans);
    font-weight: 300;
    font-size: 1.125rem;
    line-height: 1.45;
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }
  @media (max-width: 30rem) {
    body {
      font-size: 1.0625rem;
    }
  }
  /* Light text on dark reads heavier without it; dark text on light gets too thin with it. */
  @media (prefers-color-scheme: dark) {
    body {
      -webkit-font-smoothing: antialiased;
    }
  }
  h1,
  h2,
  h3 {
    line-height: 1.15;
    text-wrap: balance;
  }
  p,
  li {
    text-wrap: pretty;
  }
  a {
    text-decoration: underline;
    text-decoration-color: var(--color-muted);
    text-decoration-thickness: 1px;
    text-underline-offset: 0.15em;
    transition: text-decoration-color 120ms ease-out;
  }
  @media (hover: hover) and (pointer: fine) {
    a:hover {
      text-decoration-color: currentColor;
    }
  }
  a:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
    border-radius: 2px;
  }
}
`

const GITIGNORE = `node_modules
dist
.DS_Store
`

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const indexHtml = (name: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(name)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`

const websiteApp = (name: string) => `const name = ${JSON.stringify(name)}

const notes = [
  'What this is, in a few words.',
  'Who it is for.',
  'How to start.',
]

export default function App() {
  return (
    <main className="mx-auto max-w-page px-6 py-24">
      <div className="max-w-column">
        <p className="font-normal">{name}</p>

        <h1 className="mt-12 text-title">A short line that says what this is.</h1>
        <p className="mt-4 text-muted">
          This page is a placeholder. Select any part of it in Gui and say what it should be.
        </p>
        <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
          <a href="mailto:hello@example.com">Get in touch</a>
          <a href="#notes">Read more</a>
        </p>

        <section id="notes" className="mt-24">
          <h2 className="text-section font-normal">What to put here</h2>
          <ul className="mt-4 border-b border-rule">
            {notes.map((note) => (
              <li key={note} className="border-t border-rule py-2">
                {note}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  )
}
`

const dashboardApp = (name: string) => `const name = ${JSON.stringify(name)}

const nav = ['Overview', 'Orders', 'Customers', 'Settings']

const stats = [
  { label: 'Revenue', value: '$48,210', change: '+12%' },
  { label: 'Orders', value: '1,284', change: '+8%' },
  { label: 'Customers', value: '932', change: '+3%' },
  { label: 'Refunds', value: '14', change: '−2%' },
]

const weeks = [32, 45, 38, 52, 61, 48, 70, 66, 74, 81, 77, 90]

const orders = [
  { id: '1042', customer: 'Ava Thompson', status: 'Paid', total: '$129.00' },
  { id: '1041', customer: 'Noah Kim', status: 'Pending', total: '$64.50' },
  { id: '1040', customer: 'Mia Patel', status: 'Paid', total: '$310.00' },
  { id: '1039', customer: 'Leo Garcia', status: 'Refunded', total: '$42.00' },
  { id: '1038', customer: 'Ella Novak', status: 'Paid', total: '$88.20' },
]

export default function App() {
  return (
    <div className="mx-auto max-w-page px-6 py-12 md:py-16">
      <header className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <p className="mr-auto font-normal">{name}</p>
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          {nav.map((item, i) => (
            <a
              key={item}
              href="#"
              aria-current={i === 0 ? 'page' : undefined}
              className={i === 0 ? 'no-underline' : 'text-muted no-underline hover:text-foreground'}
            >
              {item}
            </a>
          ))}
        </nav>
      </header>

      <main className="mt-16">
        <h1 className="text-title">Overview</h1>
        <p className="mt-2 text-muted">The last 12 weeks</p>

        <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="border-t border-rule pt-3">
              <dt className="text-muted">{stat.label}</dt>
              <dd className="mt-1 text-section tabular-nums">{stat.value}</dd>
              <dd className="mt-1 text-muted tabular-nums">{stat.change}</dd>
            </div>
          ))}
        </dl>

        <section className="mt-16">
          <h2 className="text-section font-normal">Revenue by week</h2>
          <div className="mt-6 flex h-40 items-end gap-1.5 border-b border-rule sm:gap-3">
            {weeks.map((value, i) => (
              <div key={i} className="flex-1 bg-muted/30" style={{ height: \`\${value}%\` }} />
            ))}
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-section font-normal">Recent orders</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left whitespace-nowrap tabular-nums">
              <thead className="text-muted">
                <tr className="border-b border-rule">
                  <th className="hidden py-2 pr-6 font-normal sm:table-cell">Order</th>
                  <th className="py-2 pr-6 font-normal">Customer</th>
                  <th className="py-2 pr-6 font-normal">Status</th>
                  <th className="py-2 text-right font-normal">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-rule">
                    <td className="hidden py-2 pr-6 text-muted sm:table-cell">{order.id}</td>
                    <td className="py-2 pr-6">{order.customer}</td>
                    <td className="py-2 pr-6">{order.status}</td>
                    <td className="py-2 text-right">{order.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  )
}
`

function templateFiles(template: ProjectTemplate, name: string): Files {
  if (template === 'blank') return {}
  return {
    '.gitignore': GITIGNORE,
    'package.json': PACKAGE_JSON,
    'vite.config.js': VITE_CONFIG,
    'index.html': indexHtml(name),
    'src/main.jsx': MAIN,
    'src/index.css': CSS,
    'src/App.jsx': template === 'website' ? websiteApp(name) : dashboardApp(name),
  }
}

/** Writes `template`'s files into the new project at `root`, named `name` in the page. */
export async function writeTemplate(root: string, template: ProjectTemplate, name: string) {
  for (const [path, text] of Object.entries(templateFiles(template, name))) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, { flag: 'wx' })
  }
}
