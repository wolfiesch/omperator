// Adapted from T3 Code apps/web/src/components/AnimatedHeight.tsx (MIT, T3
// Tools Inc.). OMP changes: duration bound to --motion-duration-base token.
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

const HEIGHT_TRANSITION_FALLBACK_MS = 250;

export function AnimatedHeight({ children }: { readonly children: ReactNode }) {
	const contentRef = useRef<HTMLDivElement>(null);
	const [heightState, setHeightState] = useState<{
		readonly height: number | null;
		readonly isClipping: boolean;
	}>({ height: null, isClipping: false });

	useEffect(() => {
		if (!heightState.isClipping) return;
		const timeoutId = window.setTimeout(() => {
			setHeightState((currentState) =>
				currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
			);
		}, HEIGHT_TRANSITION_FALLBACK_MS);
		return () => window.clearTimeout(timeoutId);
	}, [heightState.height, heightState.isClipping]);

	useLayoutEffect(() => {
		const element = contentRef.current;
		if (!element) return;
		// The observer's entry already carries the laid-out size, and observe()
		// delivers an initial entry before the next paint, so no explicit
		// measurement is needed anywhere. The previous mount-measure plus
		// double-rAF re-measure cascade forced a synchronous layout per call
		// (scrollHeight reads), which profiled as the single largest app cost
		// while scrolling a long transcript (every freshly mounted row runs
		// this effect).
		let frame = 0;
		let pendingHeight: number | null = null;
		const commitHeight = () => {
			frame = 0;
			const nextHeight = pendingHeight;
			pendingHeight = null;
			if (nextHeight === null) return;
			setHeightState((currentState) => {
				if (currentState.height === nextHeight) return currentState;
				return {
					height: nextHeight,
					isClipping: currentState.height !== null,
				};
			});
		};
		const resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[entries.length - 1];
			if (entry === undefined) return;
			const measured = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
			pendingHeight = Math.ceil(measured);
			if (frame === 0) frame = requestAnimationFrame(commitHeight);
		});
		resizeObserver.observe(element);
		return () => {
			if (frame !== 0) cancelAnimationFrame(frame);
			resizeObserver.disconnect();
		};
	}, []);

	return (
		<div
			data-slot="animated-height"
			className="transition-[height] duration-(--motion-duration-base) ease-out motion-reduce:transition-none"
			style={
				heightState.height === null
					? undefined
					: { height: heightState.height, overflow: heightState.isClipping ? "hidden" : "visible" }
			}
			onTransitionEnd={(event) => {
				if (event.target !== event.currentTarget || event.propertyName !== "height") return;
				setHeightState((currentState) =>
					currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
				);
			}}
		>
			<div ref={contentRef}>{children}</div>
		</div>
	);
}
