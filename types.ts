type CodemodResult = string | undefined | null;

export type Codemod = {
  transform(opts: {
    source: string;
    filePath: string;
  }): CodemodResult | Promise<CodemodResult>;
}

// The `any` here is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;