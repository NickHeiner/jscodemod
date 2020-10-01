type CodemodResult = string | undefined | null;

export type Codemod = {
  /**
   * Any file matching these patterns will not be processed.
   */
  ignore?: RegExp[] | RegExp;

  /**
   * After all transforms have been run, this function will be invoked with an array of files there were modified.
   */
  postProcess?: (modifiedFiles: string[]) => Promise<unknown>;

  /**
   * Transform a single file. Return null or undefined to indicate that the file should not be modified.
   * 
   * @param opts
   * @param opts.source the contents of the file to transform.
   * @param opts.filePath the path to the file to transform.
   * @param opts.commandLineArgs arguments passed by the user in the `jscodemod` command line invocation. 
   */
  transform(opts: {
    source: string;
    filePath: string;
    commandLineArgs?: string;
  }): CodemodResult | Promise<CodemodResult>;
}

// The `any` here is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

// TODO: Maybe re-export this from the top level? If this file is on the top level itself, then tsc will output
// the built files in build/src instead of build, which messes up relative paths from src, which expects to be only
// one level down from the top.