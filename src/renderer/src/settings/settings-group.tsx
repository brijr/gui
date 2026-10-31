import { type ComponentProps, type ReactNode, useId } from 'react'
import { Card, SectionHeader } from '../lib/surface'
import { TextButton } from '../lib/ui'

/*
 * The one recipe for every Settings section:
 * - a group is a SettingsGroup: its label (an action at the end of the line, a GroupAction),
 *   an optional line about it, then a List of rows or a Card
 * - cards and rows share a 12px inset (p-3, ListItem's px-3), so their edges line up
 * - buttons in rows and cards are md (the Button default); a group's own actions are
 *   GroupActions, text-sized, beside its label
 */

interface SettingsGroupProps {
  /** The group's label, sentence case */
  heading: ReactNode
  /** A GroupAction at the end of the label's line */
  action?: ReactNode
  /** A line about the group, under its label */
  description?: ReactNode
  children?: ReactNode
}

export function SettingsGroup({ heading, action, description, children }: SettingsGroupProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <SectionHeader id={headingId} action={action}>
        {heading}
      </SectionHeader>
      {description && <p className="text-pretty text-small text-muted">{description}</p>}
      {children}
    </section>
  )
}

/** A group's own action, beside its label: "Check again", "Refresh". */
export function GroupAction(props: ComponentProps<typeof TextButton>) {
  return <TextButton {...props} />
}

interface IdentityCardProps {
  /** A 36px tile: the account's mark */
  leading: ReactNode
  heading: ReactNode
  detail?: ReactNode
  /** Buttons at the end of the first line */
  trailing?: ReactNode
  /** More under it: a status, buttons */
  children?: ReactNode
}

/** Who's signed in (or what to do about it), at the top of Account and GitHub. */
export function IdentityCard({ leading, heading, detail, trailing, children }: IdentityCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {leading}
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium">{heading}</p>
          {detail && <p className="text-pretty text-small break-words text-muted">{detail}</p>}
        </div>
        {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
      </div>
      {children}
    </Card>
  )
}

const TILE_TONE = {
  /** A brand's own tile (GitHub's black), with an edge that shows in dark mode */
  brand: 'bg-tile text-tile-fg ring-tile-edge',
  neutral: 'bg-fill text-muted ring-line',
} as const

/** The 36px tile at the start of an IdentityCard. */
export function IdentityTile({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof TILE_TONE
  children: ReactNode
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${TILE_TONE[tone]}`}
    >
      {children}
    </span>
  )
}
