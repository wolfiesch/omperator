/** Stable coordinates for one live session without importing workspace projection code. */
export interface LiveSessionAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

/** Stable coordinates for one live project without importing workspace projection code. */
export interface LiveProjectAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly projectId: string;
}
