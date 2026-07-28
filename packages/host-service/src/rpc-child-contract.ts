export interface RpcChildInvocation {
  readonly executable: string;
  readonly prefixArgv: readonly string[];
}

export interface RpcChildInvocationOverrides {
  readonly compiled?: boolean;
  readonly executable?: string;
  readonly main?: string;
}
