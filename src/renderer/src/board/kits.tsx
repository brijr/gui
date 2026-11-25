import { useEffect, useState } from 'react'
import { STYLE_KITS, type StyleKit, type StyleKitId } from '../../../shared/style-kits'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { Button, PRESS, Spinner } from '../lib/ui'

/** A kit's look, drawn from its own light values: background, a heading, a pill, two swatches. */
function KitSample({ kit }: { kit: StyleKit }) {
  const v = kit.light
  return (
    <span
      aria-hidden="true"
      className="flex h-16 items-center gap-2 rounded-md border px-3"
      style={{
        background: v['--background'],
        borderColor: v['--border'],
        color: v['--foreground'],
      }}
    >
      <span className="text-title font-semibold" style={{ fontFamily: v['--font-heading'] }}>
        Aa
      </span>
      <span
        className="h-4 w-8"
        style={{ background: v['--primary'], borderRadius: `max(${v['--radius']}, 2px)` }}
      />
      {(['--secondary', '--accent'] as const).map((token) => (
        <span
          key={token}
          className="size-4 rounded-full border"
          style={{ background: v[token], borderColor: v['--border'] }}
        />
      ))}
    </span>
  )
}

/**
 * The style kits an empty canvas can start from. Blank hides them for this opening; once a
 * kit's files are on the canvas (its frame undone, say), No kit takes them away.
 */
export function KitGallery({ disabled }: { disabled: boolean }) {
  const [inUse, setInUse] = useState<StyleKitId | null>(null)
  const [pending, setPending] = useState<StyleKitId | 'none' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    let current = true
    window.gui.boardKitInUse().then(
      (id) => current && setInUse(id),
      (err) => current && setError(readableError(err)),
    )
    return () => {
      current = false
    }
  }, [])
  if (hidden) return null
  const busy = disabled || pending !== null
  const use = async (id: StyleKitId | null) => {
    if (busy) return
    setPending(id ?? 'none')
    setError(null)
    try {
      await window.gui.boardUseKit(id)
      // A kit's frame lands and this card goes; No kit leaves it, so read what's there now.
      if (id === null) setInUse(await window.gui.boardKitInUse())
    } catch (err) {
      setError(readableError(err))
    } finally {
      setPending(null)
    }
  }
  const using = STYLE_KITS.find((kit) => kit.id === inUse)
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">Or start from a style kit</h3>
      <ul className="-mx-1.5 grid grid-cols-2 gap-2">
        {STYLE_KITS.map((kit) => (
          <li key={kit.id}>
            <button
              type="button"
              aria-label={`Use the ${kit.name} kit`}
              aria-describedby={`kit-blurb-${kit.id}`}
              aria-busy={pending === kit.id || undefined}
              disabled={busy}
              onClick={() => void use(kit.id)}
              className={`no-drag flex w-full flex-col gap-1.5 rounded-lg p-1.5 text-left transition-[background-color,opacity] enabled:hover:bg-hover disabled:opacity-40 ${PRESS}`}
            >
              <KitSample kit={kit} />
              <span className="flex items-center gap-1.5 text-small font-medium">
                {kit.name}
                {pending === kit.id && <Spinner />}
              </span>
              <span id={`kit-blurb-${kit.id}`} className="text-pretty text-small text-muted">
                {kit.blurb}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          loading={pending === 'none'}
          disabled={busy}
          onClick={() => (using ? void use(null) : setHidden(true))}
        >
          {using ? 'No kit' : 'Blank'}
        </Button>
        {using && <p className="text-small text-muted">Using the {using.name} kit</p>}
      </div>
      {error && <InlineError>{error}</InlineError>}
    </div>
  )
}
