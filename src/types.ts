export type CodemodResult = string | undefined | null;
import {PluginTarget, TransformOptions} from '@babel/core';

type ScalarOrPromise<T> = T | Promise<T>;

import jscodemod, {Options} from './';

export type BaseCodemodArgs<ParsedArgs> = {
  filePath: string;
  // TODO: only specify this as an option to transform if parseArgs is present.
  commandLineArgs?: ParsedArgs;
}

export type Codemod<ParsedArgs = unknown> = {
  /**
   * A name for the codemod, like "transform-cjs-to-esm". Defaults to the file name. Used for logging.
   */
  name?: string;

  /**
   * Specify which files should not be transformed.
   * 
   * If a regex is passed, the any file path matching that regex will be ignored.
   * If a string is passed, any file path containing that string will be ignored.
   */
  ignore?: RegExp[] | RegExp | string[] | string;

  /**
   * Use this to block the codemod from running on files ignored by .*ignore files. The elements of this array are paths
   * to your ignore files. The ignore file will be parsed with https://www.npmjs.com/package/ignore, so only use this if
   * your ignore file format works with it. (For instance, `.eslintignore` works, but `.npmignore` is a different
   * spec.)
   * 
   * Relative file paths will be resolved relative to the current working directory, so for robustness, you probably
   * want to pass absolute paths. (Perhaps use `path.resolve(__dirname, '../path/to/your/file')`).
   * 
   * Do not pass `.gitignore`, as `.gitignore`d files are automatically ignored by the codemod.
   */
  ignoreFiles?: string[];

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
  parseArgs?: (rawCommandLineArgs?: string[]) => ScalarOrPromise<ParsedArgs>

  /**
   * After all transforms have been run, this function will be invoked once with an array of files there were modified.
   * 
   * @param modifiedFiles
   * @param opts
   * @param opts.jscodemod A function you can invoke to run another codemod phase. The options passed to this function 
   *                       default to the options derived from the original command line invocation of jscodemod. For 
   *                       example, if the user passed --resetDirtyInputFiles to the command line, then when you call
   *                       opts.jscodemod(), `resetDirtyInputFiles` will default to true.
   */
  postProcess?: (modifiedFiles: string[], opts: {
    jscodemod(
      pathToCodemod: string, 
      inputFilesPatterns: string[], 
      options: Partial<Options>
    ): ReturnType<typeof jscodemod>
  }) => Promise<unknown>;
} & ({
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
  } & BaseCodemodArgs<ParsedArgs>): CodemodResult | Promise<CodemodResult>;

  presets?: never;
  getPlugin?: never;
} | {
  transform?: never;

  /**
   * The set of babel presets needed to compile your code, like `@babel/preset-env`.
   */
  presets: TransformOptions['presets'];

  /**
   * Return a plugin that will be used to codemod your code.
   * 
   * When using this approach, be aware of the following known issues:
   *    * Some parens will be inserted erroneously: https://github.com/benjamn/recast/issues/914
   *    * A trailing comment will have a space removed:
   *          `a; /*f*\/` => `a;/*f*\/`
   * 
   * Running a code formatter like prettier may help some of these issues.
   * 
   * jscodemod bundles @babel/core and recast. If those bundled versions don't work for your project, then the 
   * getPlugin() codemod API won't work for you. Use transform() instead.
   * 
   * @param opts
   * @param opts.source the contents of the file to transform.
   * @param opts.filePath the path to the file to transform.
   * @param opts.commandLineArgs parsed arguments returned by `yourCodemod.parseArgs()`, if any.
   */
  getPlugin: (opts: BaseCodemodArgs<ParsedArgs> & {
    willNotifyOnAstChange: () => void;
    astDidChange: () => void;
  }) => ScalarOrPromise<PluginTarget>;
})

// The `any` here is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

// TODO: Maybe re-export this from the top level? If this file is on the top level itself, then tsc will output
// the built files in build/src instead of build, which messes up relative paths from src, which expects to be only
// one level down from the top.