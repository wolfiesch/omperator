declare module "vitest" {
  interface Matchers {
    toBe(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toThrow(...args: unknown[]): void;
    toBeLessThanOrEqual(expected: number): void;
    toHaveLength(expected: number): void;
    toMatchObject(expected: unknown): void;
    toMatch(expected: RegExp): void;
    readonly not: Matchers;
    readonly rejects: { toThrow(...args: unknown[]): Promise<void> };
  }
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void): void;
  export const vi: {
    stubEnv(name: string, value: string): void;
    unstubAllEnvs(): void;
    stubGlobal(name: string, value: unknown): void;
    unstubAllGlobals(): void;
  };
  export function expect<T>(value: T): Matchers;
}
