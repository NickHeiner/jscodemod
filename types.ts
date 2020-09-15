export type Codemod = {
  transform(opts: {
    source: string;
    filePath: string;
  }): string | null | Promise<string | null>;
}

// The `any` here is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;