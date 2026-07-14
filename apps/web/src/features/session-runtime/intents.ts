// The renderer→runtime intent seam. Every user action the transcript surface
// can take is one of these values, and the controller is the only thing that
// turns them into app-wire commands. The deterministic fixture controller and
// the live desktop runtime implement the same interface, so swapping runtimes
// touches nothing above this file.
//
// Real-bridge mapping (documented here so the wire stays mechanical):
//   prompt / steer / followUp → commands "session.prompt" / "session.steer" /
//     "session.followUp" carrying only the message text
//   cancel                    → command "session.cancel"
//   approval                  → confirm.res for the approval's confirmation id
//   ask                       → command "session.ui.respond" with args.requestId
//   plan                      → command "session.ui.respond" with args.requestId
//     plus confirmed / revision value
//   setModel                  → command "session.model.set" with args.selector
//     and/or args.role plus persistence:"session"
//   setThinking               → command "session.thinking.set" with args.level
//   setFast                   → command "session.fast.set" with args.enabled
//   setMode                   → no wire command exists yet; live runtimes
//     reject it and hide the control, the fixture applies it locally

/** OMP's real thinking ladder. "auto" defers to the model's own default. */
export type ThinkingLevel =
  | "auto"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
}

export type SessionMode = "build" | "plan" | "readOnly";

export function isSessionMode(value: unknown): value is SessionMode {
  return value === "build" || value === "plan" || value === "readOnly";
}

export interface PromptAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly kind: "image" | "file";
  /** Renderer-local bytes. Live runtimes consume this before issuing wire commands. */
  readonly file?: File;
}

export const IMAGE_PROMPTS_UNSUPPORTED_REASON =
  "Image prompts are not available on this host yet. Your draft and any staged images stay here.";

export type SessionIntent =
  | {
      readonly kind: "prompt";
      readonly text: string;
      readonly attachments: readonly PromptAttachment[];
    }
  | { readonly kind: "steer"; readonly text: string }
  | { readonly kind: "followUp"; readonly text: string }
  | { readonly kind: "cancel" }
  | {
      readonly kind: "approval";
      readonly approvalId: string;
      readonly decision: "approve" | "deny";
    }
  | {
      readonly kind: "ask";
      readonly askId: string;
      readonly optionIds: readonly string[];
      readonly text: string;
    }
  | {
      readonly kind: "plan";
      readonly planId: string;
      readonly action: "approve" | "revise" | "reject";
      readonly note: string;
    }
  | {
      /**
       * Switch this session's model now. `role` names an OMP model role
       * (a cycle stop); `selector` names a concrete `provider/model` pick.
       * At least one is always present. Session-scoped: never a settings
       * write from the renderer.
       */
      readonly kind: "setModel";
      readonly selector: string | null;
      readonly role: string | null;
    }
  | { readonly kind: "setThinking"; readonly level: ThinkingLevel }
  | { readonly kind: "setFast"; readonly enabled: boolean }
  | { readonly kind: "setMode"; readonly mode: SessionMode };
