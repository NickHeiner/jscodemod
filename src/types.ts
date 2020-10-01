type CodemodResult = string | undefined | null;

export type Codemod = {
  ignore?: RegExp[] | RegExp;
  transform(opts: {
    source: string;
    filePath: string;
  }): CodemodResult | Promise<CodemodResult>;
}

// The `any` here is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

// TODO: Maybe re-export this from the top level? If this file is on the top level itself, then tsc will output
// the built files in build/src instead of build, which messes up relative paths from src, which expects to be only
// one level down from the top.