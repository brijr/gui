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

let images: SymbolImages = {}
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const snapshot = () => images

// One request per renderer, including the separate chat and settings windows.
void gui
  .getSymbols()
  .then((loaded) => {
    images = loaded
    for (const listener of listeners) listener()
  })
  .catch(() => {
    // The existing icons keep controls usable if the native image bridge fails.
  })

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
  const source = useSyncExternalStore(subscribe, snapshot)[name]
  if (!source) return <Fallback className={className} style={style} {...props} />
  return (
    <span
      className={cn('sf-symbol', className)}
      style={{ ...style, maskImage: `url("${source}")` }}
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
export const ChevronRight = icon(SYMBOLS.ChevronRight, Lucide.ChevronRight)
export const Circle = icon(SYMBOLS.Circle, Lucide.Circle)
export const CircleDot = icon(SYMBOLS.CircleDot, Lucide.CircleDot)
export const CircleSlash = icon(SYMBOLS.CircleSlash, Lucide.CircleSlash)
export const Clock = icon(SYMBOLS.Clock, Lucide.Clock)
export const Crop = icon(SYMBOLS.Crop, Lucide.Crop)
export const ExternalLink = icon(SYMBOLS.ExternalLink, Lucide.ExternalLink)
export const Eye = icon(SYMBOLS.Eye, Lucide.Eye)
export const FilePen = icon(SYMBOLS.FilePen, Lucide.FilePen)
export const FileText = icon(SYMBOLS.FileText, Lucide.FileText)
export const Folder = icon(SYMBOLS.Folder, Lucide.Folder)
export const FolderOpen = icon(SYMBOLS.FolderOpen, Lucide.FolderOpen)
export const FolderPlus = icon(SYMBOLS.FolderPlus, Lucide.FolderPlus)
export const GitBranch = icon(SYMBOLS.GitBranch, Lucide.GitBranch)
export const GitPullRequest = icon(SYMBOLS.GitPullRequest, Lucide.GitPullRequest)
export const Globe = icon(SYMBOLS.Globe, Lucide.Globe)
export const History = icon(SYMBOLS.History, Lucide.History)
export const HardDrive = icon(SYMBOLS.HardDrive, Lucide.HardDrive)
export const ImageIcon = icon(SYMBOLS.ImageIcon, Lucide.ImageIcon)
export const ImagePlus = icon(SYMBOLS.ImagePlus, Lucide.ImagePlus)
export const Info = icon(SYMBOLS.Info, Lucide.Info)
export const KeyRound = icon(SYMBOLS.KeyRound, Lucide.KeyRound)
export const Laptop = icon(SYMBOLS.Laptop, Lucide.Laptop)
export const Link = icon(SYMBOLS.Link, Lucide.Link)
export const Maximize2 = icon(SYMBOLS.Maximize2, Lucide.Maximize2)
export const MessageSquare = icon(SYMBOLS.MessageSquare, Lucide.MessageSquare)
export const Minus = icon(SYMBOLS.Minus, Lucide.Minus)
export const Monitor = icon(SYMBOLS.Monitor, Lucide.Monitor)
export const MousePointer2 = icon(SYMBOLS.MousePointer2, Lucide.MousePointer2)
export const Package = icon(SYMBOLS.Package, Lucide.Package)
export const Pencil = icon(SYMBOLS.Pencil, Lucide.Pencil)
export const PanelLeft = icon(SYMBOLS.PanelLeft, Lucide.PanelLeft)
export const PanelLeftClose = icon(SYMBOLS.PanelLeftClose, Lucide.PanelLeftClose)
export const Play = icon(SYMBOLS.Play, Lucide.Play)
export const Plus = icon(SYMBOLS.Plus, Lucide.Plus)
export const Redo2 = icon(SYMBOLS.Redo2, Lucide.Redo2)
export const RotateCw = icon(SYMBOLS.RotateCw, Lucide.RotateCw)
export const Search = icon(SYMBOLS.Search, Lucide.Search)
export const Shield = icon(SYMBOLS.Shield, Lucide.Shield)
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
