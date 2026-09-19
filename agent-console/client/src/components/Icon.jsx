/**
 * One icon set for the whole console, drawn from lucide-react — the set shadcn/ui
 * is designed around, so a generated component and a hand-written page reach for
 * the same glyphs at the same stroke weight.
 *
 * This is a registry, not a component library: it maps the console's vocabulary
 * ("plug", "runs", "compact") onto lucide's, so call sites name the concept rather
 * than the picture. That indirection is what lets `<Icon name="models" />` appear in
 * a nav item, a dashboard tile and a tab strip and stay consistent if the glyph
 * behind it is ever reconsidered.
 */

import {
  Activity,
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Code,
  Coins,
  Command as CommandGlyph,
  Copy,
  Database,
  Download,
  EllipsisVertical,
  ExternalLink,
  File,
  FileText,
  Filter,
  Gauge,
  Image,
  Info,
  LayoutDashboard,
  LayoutGrid,
  List,
  Menu,
  MessageSquare,
  Moon,
  PanelLeft,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Shrink,
  Sparkles,
  Sun,
  Table,
  Trash2,
  TriangleAlert,
  User,
  Wrench,
  X,
} from "lucide-react";

const glyphs = {
  /* --- Navigation --- */
  dashboard: LayoutDashboard,
  chat: MessageSquare,
  agents: Bot,
  models: Database,
  plug: Plug,
  skills: Sparkles,
  runs: Activity,
  tokens: Coins,

  /* --- Actions --- */
  plus: Plus,
  search: Search,
  menu: Menu,
  close: X,
  send: ArrowUp,
  down: ArrowDown,
  chevron: ChevronDown,
  arrow: ArrowRight,
  check: Check,
  tool: Wrench,
  copy: Copy,
  trash: Trash2,
  edit: Pencil,
  settings: Settings,
  refresh: RefreshCw,
  download: Download,
  play: Play,
  pin: Pin,
  unpin: PinOff,
  paperclip: Paperclip,

  /* --- Objects --- */
  spark: Sparkles,
  shield: ShieldCheck,
  document: FileText,
  code: Code,
  table: Table,
  image: Image,
  file: File,
  user: User,

  /* --- State --- */
  alert: TriangleAlert,
  info: Info,
  checkCircle: CircleCheck,
  xCircle: CircleX,
  clock: Clock,
  /** An arc with a needle: how full something is, rather than how much of it there is. */
  gauge: Gauge,
  /** Arrows folding inward: the shape used for compaction. */
  compact: Shrink,

  /* --- Table, toolbar and shell --- */
  /** Both arrows, for a sortable column that is not currently the sort key. */
  sort: ArrowUpDown,
  sortAsc: ArrowUpNarrowWide,
  sortDesc: ArrowDownWideNarrow,
  filter: Filter,
  /** The ⌘ key, for the palette trigger. */
  command: CommandGlyph,
  dots: EllipsisVertical,
  panelLeft: PanelLeft,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  external: ExternalLink,
  layoutList: List,
  layoutGrid: LayoutGrid,

  /* --- Theme --- */
  sun: Sun,
  moon: Moon,
};

/**
 * The console's default stroke. lucide ships at 2; 1.8 sits better beside
 * Aileron at these sizes and keeps a 14px glyph from going heavy.
 */
export function Icon({ name, className = "h-4 w-4", strokeWidth = 1.8 }) {
  const Glyph = glyphs[name];
  if (!Glyph) return null;
  return (
    <Glyph
      className={`${className} shrink-0`}
      strokeWidth={strokeWidth}
      aria-hidden="true"
    />
  );
}
