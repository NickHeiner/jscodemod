type CodemodResult = string | undefined | null;

type ScalarOrPromise<T> = T | Promise<T>;
type ParsedArgs = Record<string, unknown> | undefined;

export type Transform = {
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
      * @param opts.commandLineArgs parsed arguments returned by `yourCodemod.parseArgs()`, if any.
      */
     transform(opts: {
       source: string;
       filePath: string;
       // TODO: only specify this as an option to transform if parseArgs is present.
       commandLineArgs?: ParsedArgs;
     }): ScalarOrPromise<CodemodResult>;
}

export type DetectLabel = string | undefined;
export type Detect = {
  detect(opts: {
    source: string;
    filePath: string;
    // TODO: only specify this as an option to transform if parseArgs is present.
    commandLineArgs?: ParsedArgs;
  }): ScalarOrPromise<DetectLabel>
}

export type Codemod = {
  /**
   * Any file matching these patterns will not be processed.
   */
  ignore?: RegExp[] | RegExp;

  /**
   * Parse arguments for the codemod.
   * 
   * Optionally, your codemod can take arguments. For instance, it might take the name of a variable to rename.
   * Users pass this via passthrough args: `jscodemod --codemod c.js filePatterns -- --args --to --pass-through`.
   * 
   * jscodemod has a coordinator thread and worker threads. Before spawning worker threads, the coordinator will call
   * this method to ensure that the arguments are parsed correctly. If this method throws an error or calls 
   * process.exit(), the worker threads will not be spawned. For instance, if you use yargs, it will call process.exit()
   * and output help text when the command line args are invalid.
   * 
   * Then, each worker thread will call parseArgs() before transforming files. The reason that the worker threads also
   * call parseArgs() is that it allows you to return any value from parseArgs() and have that be supplied to 
   * transform(). If the coordinator thread called parseArgs() and passed the value to all workers, then it would have
   * to be values that can pass through the thread boundary.
   * 
   * @param rawCommandLineArgs a string of passed arguments, like "--args --to --pass-through"
   */
  parseArgs?: (rawCommandLineArgs?: string) => ScalarOrPromise<ParsedArgs>
  // TODO: Can we make the type of returned args flow through to transform better?
} & (Transform | Detect)

// The `any` here is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

// TODO: Maybe re-export this from the top level? If this file is on the top level itself, then tsc will output
// the built files in build/src instead of build, which messes up relative paths from src, which expects to be only
// one level down from the top.