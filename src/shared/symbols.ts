/** App icons and their system SF Symbol names. Only this catalog is loaded by main. */
export const SYMBOLS = {
  AppWindow: 'macwindow',
  Archive: 'archivebox',
  ArrowLeft: 'arrow.left',
  ArrowRight: 'arrow.right',
  ArrowUp: 'arrow.up',
  // Steer: the message turns into the reply under way.
  CornerUpRight: 'arrow.turn.up.right',
  ArrowDownCircle: 'arrow.down.circle',
  Bot: 'cpu',
  Brain: 'brain',
  Camera: 'camera',
  Check: 'checkmark',
  ChevronDown: 'chevron.down',
  ChevronLeft: 'chevron.left',
  ChevronRight: 'chevron.right',
  ChevronUp: 'chevron.up',
  Circle: 'circle',
  // An outline ring, as the toolbar's other tools are outlines; a solid dot outweighed them.
  CircleDot: 'record.circle',
  CircleSlash: 'nosign',
  CircleUser: 'person.crop.circle',
  Clock: 'clock',
  Crop: 'crop',
  Ellipsis: 'ellipsis',
  ExternalLink: 'arrow.up.right',
  Eye: 'eye',
  FilePen: 'pencil.and.outline',
  FileText: 'doc.text',
  Folder: 'folder',
  FolderOpen: 'folder',
  FolderPlus: 'folder.badge.plus',
  Globe: 'globe',
  History: 'clock.arrow.circlepath',
  Group: 'rectangle.dashed',
  Hand: 'hand.raised',
  HardDrive: 'externaldrive',
  // Saves the frame as an image: a picture with a down arrow, not Share's box and up arrow.
  ImageDown: 'photo.badge.arrow.down',
  ImageIcon: 'photo',
  Info: 'info.circle',
  KeyRound: 'key',
  Laptop: 'laptopcomputer',
  Maximize2: 'arrow.up.left.and.arrow.down.right',
  MessageSquare: 'bubble',
  Mic: 'mic',
  MicOff: 'mic.slash',
  Minus: 'minus',
  Monitor: 'display',
  Package: 'shippingbox',
  Paperclip: 'paperclip',
  Pencil: 'pencil',
  PictureInPicture2: 'pip',
  PanelLeft: 'sidebar.left',
  Play: 'play.fill',
  // Queue: the message joins the list waiting for the agent.
  ListPlus: 'text.badge.plus',
  Plus: 'plus',
  Redo2: 'arrow.uturn.forward',
  Reply: 'arrowshape.turn.up.left',
  RotateCw: 'arrow.clockwise',
  Search: 'magnifyingglass',
  Shapes: 'square.on.circle',
  Shield: 'shield',
  ShieldCheck: 'checkmark.shield',
  Smartphone: 'iphone',
  Square: 'stop.fill',
  SquareArrowOutDownLeft: 'arrow.down.left.square',
  SquarePen: 'square.and.pencil',
  SquareTerminal: 'terminal',
  Tablet: 'ipad',
  Trash2: 'trash',
  TriangleAlert: 'exclamationmark.triangle',
  Undo2: 'arrow.uturn.backward',
  Wrench: 'wrench',
  X: 'xmark',
} as const

export type SymbolName = (typeof SYMBOLS)[keyof typeof SYMBOLS]
/**
 * A symbol as macOS draws it, and its size in icon boxes: a plain circle fills the box, and
 * every other symbol keeps its size beside it (a chevron is narrower, a laptop wider).
 */
export interface SymbolImage {
  src: string
  width: number
  height: number
}

export type SymbolImages = Partial<Record<SymbolName, SymbolImage>>
