// @t4-code/ui — T4 Code design-system core.
// tokens.css (import "@t4-code/ui/tokens.css") owns every raw
// color; everything exported here consumes tokens only.

export { cn } from "./lib/cn.ts";
export {
	resolveHighestPriorityStatus,
	type SessionStatus,
	STATUS_PILLS,
	STATUS_PRIORITY,
	type StatusPillStyle,
} from "./lib/status.ts";

export { Badge, type BadgeProps, badgeVariants } from "./primitives/badge.tsx";
export { Button, type ButtonProps, buttonVariants } from "./primitives/button.tsx";
export {
	Dialog,
	DialogBackdrop,
	DialogClose,
	DialogContent,
	DialogCreateHandle,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPanel,
	DialogPopup,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
	DialogViewport,
} from "./primitives/dialog.tsx";
export {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "./primitives/empty.tsx";
export {
	IconButton,
	type IconButtonProps,
	type IconButtonSize,
} from "./primitives/icon-button.tsx";
export { ScrollArea, ScrollBar } from "./primitives/scroll-area.tsx";
export {
	Sheet,
	SheetBackdrop,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetOverlay,
	SheetPanel,
	SheetPopup,
	SheetPortal,
	SheetTitle,
	SheetTrigger,
} from "./primitives/sheet.tsx";
export { Skeleton } from "./primitives/skeleton.tsx";
export { Spinner } from "./primitives/spinner.tsx";
export { StatusPill, type StatusPillProps } from "./primitives/status-pill.tsx";
export {
	Tooltip,
	TooltipCreateHandle,
	TooltipPopup,
	TooltipProvider,
	TooltipTrigger,
} from "./primitives/tooltip.tsx";

export { AnimatedHeight } from "./motion/AnimatedHeight.tsx";
export {
	type MotionPreference,
	REDUCED_MOTION_QUERY,
	resolveReducedMotion,
	useReducedMotion,
} from "./motion/useReducedMotion.ts";

export {
	clampWidth,
	parsePersistedWidth,
	resolveDragWidth,
	type WidthBounds,
} from "./layout/resize.ts";
export {
	type ResizableWidthHandlers,
	type UseResizableWidthOptions,
	useResizableWidth,
} from "./layout/useResizableWidth.ts";

export { BrandLockup, type BrandLockupProps } from "./brand/BrandLockup.tsx";
export { OmpMark, type OmpMarkProps } from "./brand/OmpMark.tsx";

export {
	createXtermTheme,
	isRenderableColor,
	type ReadToken,
	XTERM_TOKEN_MAP,
	xtermThemeFromElement,
} from "./terminal/xtermTheme.ts";

export { PrimitiveGallery } from "./gallery/PrimitiveGallery.tsx";
