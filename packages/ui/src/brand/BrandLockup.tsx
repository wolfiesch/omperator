// T4 Code brand lockup: the exact OMP pi/plugin mark beside the product
// wordmark. The mark is decorative here — "T4 Code" is real text, so the
// lockup carries its own accessible name. `byline` adds the runtime
// relationship ("Powered by Oh My Pi") for hierarchy surfaces only
// (onboarding, about, empty welcome) — never on working chrome.
import type * as React from "react";

import { cn } from "../lib/cn.ts";
import { OmpMark } from "./OmpMark.tsx";

interface BrandLockupProps extends React.ComponentProps<"div"> {
	/** sm fits chrome (titlebar); lg fits welcome/onboarding surfaces. */
	readonly size?: "sm" | "lg";
	/** Show the "Powered by Oh My Pi" runtime byline under the wordmark. */
	readonly byline?: boolean;
}

function BrandLockup({ size = "sm", byline = false, className, ...props }: BrandLockupProps) {
	return (
		<div
			className={cn("flex min-w-0 flex-col", byline && "items-center gap-1.5", className)}
			data-slot="brand-lockup"
			{...props}
		>
			<span className={cn("flex min-w-0 items-center", size === "lg" ? "gap-2.5" : "gap-2")}>
				<OmpMark
					className={cn("w-auto shrink-0", size === "lg" ? "h-7" : "h-4")}
					title={null}
				/>
				<span
					className={cn(
						"truncate",
						size === "lg" ? "font-heading font-semibold text-xl" : "font-medium text-sm",
					)}
				>
					T4 Code
				</span>
			</span>
			{byline && <span className="text-muted-foreground text-xs">Powered by Oh My Pi</span>}
		</div>
	);
}

export { BrandLockup, type BrandLockupProps };
