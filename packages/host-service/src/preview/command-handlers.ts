import {
  type CommandFrame,
  decodeCommandArguments,
  type HostId,
  type PreviewAction,
  previewCaptureId,
  previewId,
  type PreviewSnapshot,
  type SessionId,
} from "@t4-code/host-wire";
import { appserverResponse } from "../appserver-response.ts";
import type { AppserverCommandHandlers } from "../command-handler.ts";
import type { CommandOutcome } from "../types.ts";
import type { PreviewService } from "./preview-service.ts";
import { PreviewServiceError } from "./types.ts";

export interface PreviewCommandHandlerOptions {
  readonly handlers: AppserverCommandHandlers;
  readonly hostId: () => HostId;
  readonly service: PreviewService;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

export function registerPreviewCommandHandlers(options: PreviewCommandHandlerOptions): void {
  new PreviewCommandRouter(options).register();
}

class PreviewCommandRouter {
  readonly #handlers: AppserverCommandHandlers;
  readonly #hostId: () => HostId;
  readonly #service: PreviewService;
  readonly #log: PreviewCommandHandlerOptions["log"];

  constructor(options: PreviewCommandHandlerOptions) {
    this.#handlers = options.handlers;
    this.#hostId = options.hostId;
    this.#service = options.service;
    this.#log = options.log;
  }

  register(): void {
    this.#handlers.register("preview.launch", (command) => this.launch(command));
    this.#handlers.register("preview.state", (command) => this.state(command));
    this.#handlers.register("preview.activate", (command) => this.activate(command));
    this.#handlers.register("preview.navigate", (command) => this.navigate(command));
    this.#handlers.register("preview.back", (command) => this.back(command));
    this.#handlers.register("preview.forward", (command) => this.forward(command));
    this.#handlers.register("preview.reload", (command) => this.reload(command));
    this.#handlers.register("preview.close", (command) => this.close(command));
    this.#handlers.register("preview.capture", (command) => this.capture(command));
    this.#handlers.register("preview.capture.read", (command) => this.captureRead(command));
    this.#handlers.register("preview.click", (command) => this.click(command));
    this.#handlers.register("preview.fill", (command) => this.fill(command));
    this.#handlers.register("preview.scroll", (command) => this.scroll(command));
    this.#handlers.register("preview.type", (command) => this.type(command));
    this.#handlers.register("preview.select", (command) => this.select(command));
    this.#handlers.register("preview.press", (command) => this.press(command));
    this.#handlers.register("preview.upload", (command) => this.upload(command));
    this.#handlers.register("preview.policy.check", (command) => this.policyCheck(command));
    this.#handlers.register("preview.lease.acquire", (command) => this.leaseAcquire(command));
    this.#handlers.register("preview.lease.renew", (command) => this.leaseRenew(command));
    this.#handlers.register("preview.lease.release", (command) => this.leaseRelease(command));
    this.#handlers.register("preview.handoff", (command) => this.handoff(command));
  }

  private response(command: CommandFrame, result: unknown): CommandOutcome {
    return { frame: appserverResponse(this.#hostId(), command, true, result) };
  }

  private error(command: CommandFrame, error: unknown): CommandOutcome {
    if (error instanceof PreviewServiceError)
      return {
        frame: appserverResponse(this.#hostId(), command, false, undefined, {
          code: error.code,
          message: error.message,
        }),
      };
    return {
      frame: appserverResponse(this.#hostId(), command, false, undefined, {
        code: "preview_failed",
        message: error instanceof Error ? error.message : "preview operation failed",
      }),
    };
  }

  private async launch(command: CommandFrame): Promise<CommandOutcome> {
    this.#log("preview.launch.start", { sessionId: command.sessionId });
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.launch({
        sessionId: command.sessionId!,
        url: args.url as string,
        ...(args.authorityId !== undefined ? { authorityId: args.authorityId as string } : {}),
      });
      this.#log("preview.launch.done", { sessionId: command.sessionId });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async state(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      return this.response(
        command,
        await this.#service.state({
          sessionId: command.sessionId!,
          ...(args.previewId !== undefined ? { previewId: previewId(args.previewId) } : {}),
        }),
      );
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async activate(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.activate({
        sessionId: command.sessionId!,
        previewId: previewId(args.previewId),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async navigate(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.navigate({
        sessionId: command.sessionId!,
        previewId: previewId(args.previewId),
        url: args.url as string,
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async back(command: CommandFrame): Promise<CommandOutcome> {
    return this.navigation(command, (args, sessionId) =>
      this.#service.back({
        sessionId,
        previewId: previewId(args.previewId),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      }),
    );
  }

  private async forward(command: CommandFrame): Promise<CommandOutcome> {
    return this.navigation(command, (args, sessionId) =>
      this.#service.forward({
        sessionId,
        previewId: previewId(args.previewId),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      }),
    );
  }

  private async reload(command: CommandFrame): Promise<CommandOutcome> {
    return this.navigation(command, (args, sessionId) =>
      this.#service.reload({
        sessionId,
        previewId: previewId(args.previewId),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      }),
    );
  }

  private async close(command: CommandFrame): Promise<CommandOutcome> {
    return this.navigation(command, (args, sessionId) =>
      this.#service.close({
        sessionId,
        previewId: previewId(args.previewId),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      }),
    );
  }

  private async capture(command: CommandFrame): Promise<CommandOutcome> {
    return this.navigation(command, (args, sessionId) =>
      this.#service.capture({
        sessionId,
        previewId: previewId(args.previewId),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      }),
    );
  }

  private captureRead(command: CommandFrame): CommandOutcome {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      return this.response(
        command,
        this.#service.captureRead({
          sessionId: command.sessionId!,
          previewId: previewId(args.previewId),
          captureId: previewCaptureId(args.captureId),
          offset: args.offset as number,
        }),
      );
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async click(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.click({
        sessionId: command.sessionId!,
        previewId: previewId(args.previewId),
        ...(args.selector !== undefined ? { selector: args.selector as string } : {}),
        ...(args.x !== undefined ? { x: args.x as number } : {}),
        ...(args.y !== undefined ? { y: args.y as number } : {}),
        ...(args.button !== undefined
          ? { button: args.button as "left" | "middle" | "right" }
          : {}),
        ...(args.clickCount !== undefined ? { clickCount: args.clickCount as number } : {}),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async fill(command: CommandFrame): Promise<CommandOutcome> {
    return this.textInput(command, (args, sessionId) =>
      this.#service.fill({
        sessionId,
        previewId: previewId(args.previewId),
        selector: args.selector as string,
        text: args.text as string,
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      }),
    );
  }

  private async type(command: CommandFrame): Promise<CommandOutcome> {
    return this.textInput(command, (args, sessionId) =>
      this.#service.type({
        sessionId,
        previewId: previewId(args.previewId),
        text: args.text as string,
        ...(args.selector !== undefined ? { selector: args.selector as string } : {}),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      }),
    );
  }

  private async scroll(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.scroll({
        sessionId: command.sessionId!,
        previewId: previewId(args.previewId),
        deltaX: args.deltaX as number,
        deltaY: args.deltaY as number,
        ...(args.selector !== undefined ? { selector: args.selector as string } : {}),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async select(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.selectOption({
        sessionId: command.sessionId!,
        previewId: previewId(args.previewId),
        selector: args.selector as string,
        value: args.value as string,
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async press(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.press({
        sessionId: command.sessionId!,
        previewId: previewId(args.previewId),
        key: args.key as string,
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private upload(command: CommandFrame): CommandOutcome {
    return this.error(
      command,
      new PreviewServiceError("unsupported", "preview upload is not yet implemented"),
    );
  }

  private policyCheck(command: CommandFrame): CommandOutcome {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      return this.response(
        command,
        this.#service.policyCheck({
          action: args.action as PreviewAction,
          ...(args.previewId !== undefined ? { previewId: previewId(args.previewId) } : {}),
          ...(args.url !== undefined ? { url: args.url as string } : {}),
          ...(args.authorityId !== undefined ? { authorityId: args.authorityId as string } : {}),
        }),
      );
    } catch (error) {
      return this.error(command, error);
    }
  }

  private leaseAcquire(command: CommandFrame): CommandOutcome {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      return this.response(
        command,
        this.#service.leaseAcquire({
          sessionId: command.sessionId!,
          previewId: previewId(args.previewId),
          ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs as number } : {}),
        }),
      );
    } catch (error) {
      return this.error(command, error);
    }
  }

  private leaseRenew(command: CommandFrame): CommandOutcome {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      return this.response(
        command,
        this.#service.leaseRenew({
          sessionId: command.sessionId!,
          previewId: previewId(args.previewId),
          leaseId: args.leaseId as never,
          ...(args.ttlMs !== undefined ? { ttlMs: args.ttlMs as number } : {}),
        }),
      );
    } catch (error) {
      return this.error(command, error);
    }
  }

  private leaseRelease(command: CommandFrame): CommandOutcome {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      return this.response(
        command,
        this.#service.leaseRelease({
          sessionId: command.sessionId!,
          previewId: previewId(args.previewId),
          leaseId: args.leaseId as never,
        }),
      );
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async handoff(command: CommandFrame): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      const snapshot = await this.#service.handoff({
        sessionId: command.sessionId!,
        previewId: previewId(args.previewId),
        message: args.message as string,
        ...(args.mode !== undefined
          ? { mode: args.mode as "manual" | "selector" | "url" | "text" }
          : {}),
        ...(args.selector !== undefined ? { selector: args.selector as string } : {}),
        ...(args.urlSubstring !== undefined ? { urlSubstring: args.urlSubstring as string } : {}),
        ...(args.text !== undefined ? { text: args.text as string } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs as number } : {}),
        ...(args.leaseId !== undefined ? { leaseId: args.leaseId as never } : {}),
      });
      return this.response(command, { preview: snapshot });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async navigation(
    command: CommandFrame,
    action: (args: Record<string, unknown>, sessionId: SessionId) => Promise<PreviewSnapshot>,
  ): Promise<CommandOutcome> {
    try {
      const args = decodeCommandArguments(command.command, command.args);
      return this.response(command, { preview: await action(args, command.sessionId!) });
    } catch (error) {
      return this.error(command, error);
    }
  }

  private async textInput(
    command: CommandFrame,
    action: (args: Record<string, unknown>, sessionId: SessionId) => Promise<PreviewSnapshot>,
  ): Promise<CommandOutcome> {
    return this.navigation(command, action);
  }
}
