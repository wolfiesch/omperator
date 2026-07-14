import { Button, cn, type MotionPreference, useReducedMotion } from "@t4-code/ui";
import { CircleAlert, Image as ImageIcon, ImageOff, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { TranscriptImageSource } from "../session-runtime/transcript-images.ts";
import type { TranscriptImageReference } from "./image-metadata.ts";

export interface TranscriptImagesProps {
  readonly source: TranscriptImageSource;
  readonly images: readonly TranscriptImageReference[];
  readonly issue: string | null;
  readonly label: string;
  readonly className?: string;
  readonly motionPreference?: MotionPreference;
}

function ImageState({
  icon: Icon,
  text,
  role,
}: {
  readonly icon: typeof ImageIcon;
  readonly text: string;
  readonly role: "note" | "status";
}) {
  return (
    <div
      aria-label={text}
      className="flex aspect-4/3 w-full items-center justify-center gap-2 rounded-lg border border-border bg-secondary px-3 text-center text-muted-foreground text-xs"
      role={role}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function TranscriptImage({
  source,
  reference,
  alt,
  motionPreference,
}: {
  readonly source: TranscriptImageSource;
  readonly reference: TranscriptImageReference;
  readonly alt: string;
  readonly motionPreference?: MotionPreference;
}) {
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(reference, listener),
    [reference, source],
  );
  const getSnapshot = useCallback(
    () => source.getSnapshot(reference),
    [reference, source],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const reducedMotion = useReducedMotion(motionPreference);
  const [animationVisible, setAnimationVisible] = useState(() => !reducedMotion);

  useEffect(() => source.retain(reference), [reference, source]);
  useEffect(() => {
    if (reducedMotion) setAnimationVisible(false);
  }, [reducedMotion]);

  if (snapshot.status === "loading") {
    return <ImageState icon={ImageIcon} role="note" text="Loading image…" />;
  }
  if (snapshot.status === "unavailable") {
    return <ImageState icon={ImageOff} role="note" text={snapshot.reason} />;
  }
  if (snapshot.status === "error") {
    return <ImageState icon={CircleAlert} role="note" text={snapshot.reason} />;
  }
  const showImage = !snapshot.animated || animationVisible;
  const animationLabel = animationVisible ? "Pause animation" : "Play animation";
  return (
    <figure className="relative flex aspect-4/3 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-secondary">
      {showImage ? (
        <img
          alt={alt}
          className="block max-h-full max-w-full object-contain"
          decoding="async"
          draggable={false}
          loading="lazy"
          onError={() => source.reportDecodeFailure(reference)}
          src={snapshot.url}
        />
      ) : (
        <div
          aria-label={`${alt}. Animated image paused.`}
          className="flex h-full w-full items-center justify-center gap-2 px-3 text-center text-muted-foreground text-xs"
          role="img"
        >
          <ImageIcon aria-hidden="true" className="size-4 shrink-0" />
          <span>Animation paused</span>
        </div>
      )}
      {snapshot.animated && (
        <Button
          aria-label={animationLabel}
          aria-pressed={animationVisible}
          className="absolute right-2 bottom-2 bg-popover/90 backdrop-blur-sm"
          onClick={() => setAnimationVisible((visible) => !visible)}
          size="sm"
          variant="outline"
        >
          {animationVisible ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {animationVisible ? "Pause" : "Play"}
        </Button>
      )}
    </figure>
  );
}

/** Ordered evidence strip: horizontal on narrow panes, wrapped at desktop widths. */
export function TranscriptImages({
  source,
  images,
  issue,
  label,
  className,
  motionPreference,
}: TranscriptImagesProps) {
  if (images.length === 0 && issue === null) return null;
  return (
    <div
      aria-label={`${label} images`}
      className={cn(
        "mt-2 flex max-w-full gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible",
        className,
      )}
      role="group"
    >
      {issue !== null && (
        <div className="w-[min(18rem,72vw)] max-w-full shrink-0 sm:w-56">
          <ImageState icon={ImageOff} role="note" text={issue} />
        </div>
      )}
      {images.map((reference, index) => (
        <div
          className="w-[min(18rem,72vw)] max-w-full shrink-0 sm:w-56"
          key={`${reference.entryId}:${reference.sha256}:${index}`}
        >
          <TranscriptImage
            alt={`${label} image ${index + 1} of ${images.length}`}
            {...(motionPreference === undefined ? {} : { motionPreference })}
            reference={reference}
            source={source}
          />
        </div>
      ))}
    </div>
  );
}
