import * as Lucide from 'lucide-react'
import { type ComponentType, type CSSProperties, useSyncExternalStore } from 'react'
import { SYMBOLS, type SymbolImages, type SymbolName } from '../../../shared/symbols'
import { gui } from './api'
import { cn } from './cn'

interface IconProps {
  className?: string
  style?: CSSProperties
  'aria-hidden'?: boolean | 'true' | 'false'
  'aria-label'?: string
}

export type IconComponent = ComponentType<IconProps>

/** The symbols, once main has answered (`settled`), even with none (another platform, a failure) */
let symbols: { images: SymbolImages; settled: boolean } = { images: {}, settled: false }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const snapshot = () => symbols
const settle = (images: SymbolImages) => {
  symbols = { images, settled: true }
  for (const listener of listeners) listener()
}

// One request per renderer, including the separate chat and settings windows.
void gui
  .getSymbols()
  .then(settle)
  // The existing icons keep controls usable if the native image bridge fails.
  .catch(() => settle({}))

export function SFSymbol({
  name,
  fallback: Fallback,
  className,
  style,
  ...props
}: IconProps & {
  name: SymbolName
  fallback: IconComponent
}) {
  const { images, settled } = useSyncExternalStore(subscribe, snapshot)
  const symbol = images[name]
  // While main answers, an empty box of the icon's size: drawing the fallback first would
  // show one icon on the first frame and swap it for another.
  if (!symbol && !settled) {
    const label = props['aria-label']
    return (
      <span
        {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
        className={cn('inline-block shrink-0', className)}
        style={style}
      />
    )
  }
  if (!symbol) return <Fallback className={className} style={style} {...props} />
  return (
    <span
      className={cn('sf-symbol', className)}
      style={
        {
          ...style,
          '--symbol': `url("${symbol.src}")`,
          '--symbol-width': symbol.width,
          '--symbol-height': symbol.height,
        } as CSSProperties
      }
      role={props['aria-label'] ? 'img' : undefined}
      data-symbol={name}
      {...props}
    />
  )
}

function icon(name: SymbolName, fallback: IconComponent): IconComponent {
  return function SystemIcon(props: IconProps) {
    return <SFSymbol name={name} fallback={fallback} {...props} />
  }
}

export const AppWindow = icon(SYMBOLS.AppWindow, Lucide.AppWindow)
export const Archive = icon(SYMBOLS.Archive, Lucide.Archive)
export const ArrowLeft = icon(SYMBOLS.ArrowLeft, Lucide.ArrowLeft)
export const ArrowRight = icon(SYMBOLS.ArrowRight, Lucide.ArrowRight)
export const ArrowUp = icon(SYMBOLS.ArrowUp, Lucide.ArrowUp)
export const Bot = icon(SYMBOLS.Bot, Lucide.Bot)
export const Brain = icon(SYMBOLS.Brain, Lucide.Brain)
export const Camera = icon(SYMBOLS.Camera, Lucide.Camera)
export const Check = icon(SYMBOLS.Check, Lucide.Check)
export const ChevronDown = icon(SYMBOLS.ChevronDown, Lucide.ChevronDown)
export const ChevronLeft = icon(SYMBOLS.ChevronLeft, Lucide.ChevronLeft)
export const ChevronRight = icon(SYMBOLS.ChevronRight, Lucide.ChevronRight)
export const ChevronUp = icon(SYMBOLS.ChevronUp, Lucide.ChevronUp)
export const Circle = icon(SYMBOLS.Circle, Lucide.Circle)
export const CircleDot = icon(SYMBOLS.CircleDot, Lucide.CircleDot)
export const CircleSlash = icon(SYMBOLS.CircleSlash, Lucide.CircleSlash)
export const CircleUser = icon(SYMBOLS.CircleUser, Lucide.CircleUser)
export const Clock = icon(SYMBOLS.Clock, Lucide.Clock)
export const Copy = icon(SYMBOLS.Copy, Lucide.Copy)
export const Crop = icon(SYMBOLS.Crop, Lucide.Crop)
export const Ellipsis = icon(SYMBOLS.Ellipsis, Lucide.Ellipsis)
export const ExternalLink = icon(SYMBOLS.ExternalLink, Lucide.ExternalLink)
export const Eye = icon(SYMBOLS.Eye, Lucide.Eye)
export const FilePen = icon(SYMBOLS.FilePen, Lucide.FilePen)
export const FileText = icon(SYMBOLS.FileText, Lucide.FileText)
export const Folder = icon(SYMBOLS.Folder, Lucide.Folder)
export const FolderOpen = icon(SYMBOLS.FolderOpen, Lucide.FolderOpen)
export const FolderPlus = icon(SYMBOLS.FolderPlus, Lucide.FolderPlus)
export const GitBranch = icon(SYMBOLS.GitBranch, Lucide.GitBranch)
// Lucide's: the system's arrow.triangle.pull doesn't read as a pull request.
export const Globe = icon(SYMBOLS.Globe, Lucide.Globe)
// Lucide's dotted grip: the system's line.3.horizontal reads as a menu, not a drag handle.
export const GripVertical: IconComponent = Lucide.GripVertical
export const History = icon(SYMBOLS.History, Lucide.History)
export const Group = icon(SYMBOLS.Group, Lucide.Group)
export const Hand = icon(SYMBOLS.Hand, Lucide.Hand)
export const HardDrive = icon(SYMBOLS.HardDrive, Lucide.HardDrive)
export const ImageDown = icon(SYMBOLS.ImageDown, Lucide.ImageDown)
export const ImageIcon = icon(SYMBOLS.ImageIcon, Lucide.ImageIcon)
export const ImagePlus = icon(SYMBOLS.ImagePlus, Lucide.ImagePlus)
export const Info = icon(SYMBOLS.Info, Lucide.Info)
export const KeyRound = icon(SYMBOLS.KeyRound, Lucide.KeyRound)
export const Laptop = icon(SYMBOLS.Laptop, Lucide.Laptop)
export const Link = icon(SYMBOLS.Link, Lucide.Link)
export const Maximize2 = icon(SYMBOLS.Maximize2, Lucide.Maximize2)
export const MessageSquare = icon(SYMBOLS.MessageSquare, Lucide.MessageSquare)
export const Mic = icon(SYMBOLS.Mic, Lucide.Mic)
export const MicOff = icon(SYMBOLS.MicOff, Lucide.MicOff)
export const Minus = icon(SYMBOLS.Minus, Lucide.Minus)
export const Monitor = icon(SYMBOLS.Monitor, Lucide.Monitor)
// Lucide's outline pointer everywhere: the system's cursorarrow is a solid arrow, heavier than
// the outline icons beside it in the toolbar.
export const MousePointer2: IconComponent = Lucide.MousePointer2
// The board's Move tool, as design tools draw it: an arrow with its tail.
export const MousePointer: IconComponent = Lucide.MousePointer
export const Package = icon(SYMBOLS.Package, Lucide.Package)
export const Paperclip = icon(SYMBOLS.Paperclip, Lucide.Paperclip)
export const Pencil = icon(SYMBOLS.Pencil, Lucide.Pencil)
export const PictureInPicture2 = icon(SYMBOLS.PictureInPicture2, Lucide.PictureInPicture2)
export const PanelLeft = icon(SYMBOLS.PanelLeft, Lucide.PanelLeft)
export const Play = icon(SYMBOLS.Play, Lucide.Play)
export const Plus = icon(SYMBOLS.Plus, Lucide.Plus)
export const Redo2 = icon(SYMBOLS.Redo2, Lucide.Redo2)
export const Reply = icon(SYMBOLS.Reply, Lucide.Reply)
export const RotateCw = icon(SYMBOLS.RotateCw, Lucide.RotateCw)
// Lucide's: the system's ruler is a flat bar at toolbar size, and reads as a battery.
export const Ruler: IconComponent = Lucide.Ruler
export const Search = icon(SYMBOLS.Search, Lucide.Search)
export const Shapes = icon(SYMBOLS.Shapes, Lucide.Shapes)
export const Share = icon(SYMBOLS.Share, Lucide.Share)
export const Shield = icon(SYMBOLS.Shield, Lucide.Shield)
/** Auto while it's on: requests approved without asking. */
export const ShieldCheck = icon(SYMBOLS.ShieldCheck, Lucide.ShieldCheck)
export const ShieldOff = icon(SYMBOLS.ShieldOff, Lucide.ShieldOff)
export const Smartphone = icon(SYMBOLS.Smartphone, Lucide.Smartphone)
export const Square = icon(SYMBOLS.Square, Lucide.Square)
export const SquareArrowOutDownLeft = icon(
  SYMBOLS.SquareArrowOutDownLeft,
  Lucide.SquareArrowOutDownLeft,
)
export const SquareArrowOutUpRight = icon(
  SYMBOLS.SquareArrowOutUpRight,
  Lucide.SquareArrowOutUpRight,
)
export const SquarePen = icon(SYMBOLS.SquarePen, Lucide.SquarePen)
export const SquareTerminal = icon(SYMBOLS.SquareTerminal, Lucide.SquareTerminal)
export const Tablet = icon(SYMBOLS.Tablet, Lucide.Tablet)
export const Trash2 = icon(SYMBOLS.Trash2, Lucide.Trash2)
export const TriangleAlert = icon(SYMBOLS.TriangleAlert, Lucide.TriangleAlert)
export const Undo2 = icon(SYMBOLS.Undo2, Lucide.Undo2)
export const Wrench = icon(SYMBOLS.Wrench, Lucide.Wrench)
export const X = icon(SYMBOLS.X, Lucide.X)
