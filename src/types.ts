import type {Promisable} from 'type-fest';
import type {Options as RecastOptions} from 'recast';

import {PluginItem, TransformOptions} from '@babel/core';

import jscodemod, {Options} from './';

export type TransformedCode = string | undefined | null;
export type CodemodResult<TransformResultMeta> = TransformedCode | {code: TransformedCode, meta: TransformResultMeta};

export type BaseCodemodArgs<ParsedArgs> = {
  filePath: string;
  // TODO: only specify this as an option to transform if parseArgs is present.
  commandLineArgs?: ParsedArgs;
}

export type GetPluginResult = PluginItem | {
  /**
   * If true, use Recast to maintain code formatting. If false, just take Babel's generated output directly.
   *
   * Most of the time, you'll want this, because Babel's code generator doesn't make any attempt to match the input
   * styling. However, Recast sometimes introduces oddities of its own, as noted in
   * [the docs](https://github.com/NickHeiner/jscodemod/blob/master/docs/gotchas.md#getplugin-recast-issues).
   *
   * Defaults to true.
   */
  useRecast?: boolean;
  plugin: PluginItem;
};

export type Codemod<ParsedArgs = unknown, TransformResultMeta = unknown> = {
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
  ignore?: (RegExp | string)[] | RegExp | string;

  /**
   * Use this to block the codemod from running on files ignored by .*ignore files. The elements of this array are
   * absolute paths to your ignore files. The ignore file will be interpreted with the .gitignore spec,
   * using https://www.npmjs.com/package/ignore, so only use this if your ignore file format works with it. (For
   * instance, `.eslintignore` works, but `.npmignore` is a different spec.)
   *
   * .gitignore resolves paths relative to the .gitignore file location. So, if you have an ignore.txt file that lives
   * at `<repo-root>/codemod/ignore.txt`, and ignore.txt contains the line `*.md`, then the ignored file pattern will
   * be `<repo-root>/codemod/*.md`. If you want to ignore all Markdown files, you would instead want to write `../*.md`.
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
  parseArgs?: (rawCommandLineArgs?: string[]) => Promisable<ParsedArgs>

  /**
   * After all transforms have been run, this function will be invoked once with an array of files there were modified.
   *
   * @param modifiedFiles
   * @param opts
   * @param opts.jscodemod A function you can invoke to run another codemod phase. The options passed to this function
   *                       default to the options derived from the original command line invocation of jscodemod. For
   *                       example, if the user passed --resetDirtyInputFiles to the command line, then when you call
   *                       opts.jscodemod(), `resetDirtyInputFiles` will default to true.
   * @param opts.codemodArgs The codemod args returned by codemod.parseArgs(), if that method is defined.
   */
  postProcess?: (modifiedFiles: string[], opts: {
    codemodArgs: ParsedArgs,

    /**
     * A map from absolute file path to any TransformResultMeta that was returned by the transform
     * function. If no TransformResultMeta was returned for a file, then `resultMeta.get(filePath)`
     * will be undefined.
     */
    resultMeta: Map<string, TransformResultMeta>,
    jscodemod(
      pathToCodemod: string,
      options: Partial<Options>
    ): ReturnType<typeof jscodemod>
  }) => void | Promise<unknown>;
} & ({
  /**
   * Transform every file at once. Use this when integrating with another tool, like ts-migrate. Or when you need
   * finer-grained control over the file modification process.
   *
   * transform() and getPlugin() operate on a model where your code returns instructions on how to modify a single
   * file, and jscodemod actually writes the files. transformAll() just takes a set of files, and does whatever it
   * wants to do.
   *
   * Return a list of the modified files.
   *
   * @param opts
   * @param opts.fileNames the file names to transform
   * @param opts.commandLineArgs parsed arguments returned by `yourCodemod.parseArgs()`, if any.
   */
  transformAll(opts: {
    fileNames: string[],
    commandLineArgs?: ParsedArgs;
  }): Promisable<string[]>,

  presets?: never;
  getPlugin?: never;
  transform?: never;
} | {
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
  } & BaseCodemodArgs<ParsedArgs>): CodemodResult<TransformResultMeta> | Promise<CodemodResult<TransformResultMeta>>;

  presets?: never;
  getPlugin?: never;

  transformAll: never;
} | {
  transform?: never;

  transformAll: never;

  /**
   * The set of babel presets needed to compile your code, like `@babel/preset-env`.
   */
  presets: TransformOptions['presets'];

  /**
   * Generator options that will be passed through to the generation step.
   *
   * If your getPlugin() method returns {useRecast: true}, these options will be passed to the Babel generator.
   * If your getPlugin() method returns {useRecast: false}, these options will be passed to `recast.print`.
   *
   * Options passed to `recast.print` will only be used by recast if that part of the AST has actually been modified.
   * (More detail: https://github.com/benjamn/recast/issues/997)
   *
   * I recognize that `useRecast` can be changed on a per-file basis via getPlugin() returning a dynamic value,
   * but these generator options have to be statically declared. And you may not be able to pass one set of generator
   * options that works for both Babel and Recast. So this design may be a bit limiting. If this is an issue for you,
   * let me know.
   */
  generatorOpts?: TransformOptions['generatorOpts'] | RecastOptions;

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
   * To reduce noise associated with unintentional changes like the ones listed above, you can explicitly tell jscodemod
   * when your plugin has modified the input AST. (Unfortunately, this is very hard to figure out automatically.) To do
   * this, use the `willNotifyOnAstChange` and `astDidChange` methods passed in the options argument:
   *
   *    getPlugin({willNotifyOnAstChange, astDidChange}) {
   *      willNotifyOnAstChange();
   *
   *      return ({types}) => ({visitor:
   *        Program(path) {
   *          // when you're going to change the AST
   *          astDidChange();
   *        }
   *      })
   *    }
   *
   * It's an error to call astDidChange() if you haven't called willNotifyOnAstChange() first.
   *
   * You don't have to use the willNotifyOnAstChange API. You can ignore both these methods, and then jscodemod will
   * always transform the file. If your usecase is narrow enough, this could be fine. But if you're making a broad
   * change, and you're getting noisy changes like those listed above, then consider this API.
   *
   * getPlugin() will be called separately for each file to be processed. So, variables you keep in the closure of the
   * method body will only be accessible from that file:
   *
   *    getPlugin({filePath}) {
   *      let variableScopedToThisOneFile;
   *      return ({types}) => ({
   *        visitor: // ...
   *      })
   *    }
   *
   * jscodemod bundles @babel/core and recast. If the bundled @babel/core version doesn't work for your project, then
   * getPlugin() codemod API won't work for you. Use transform() instead. If the bundled recast version doesn't work for
   * your project, set useRecast = false. (See the useRecast definition above.)
   *
   * @param opts
   * @param opts.source the contents of the file to transform.
   * @param opts.filePath the path to the file to transform.
   * @param opts.commandLineArgs parsed arguments returned by `yourCodemod.parseArgs()`, if any.
   */
  getPlugin: (opts: BaseCodemodArgs<ParsedArgs> & {
    /** Call this if you plan to call astDidChange(). */
    willNotifyOnAstChange: () => void;

    /** Call this if you modified the AST, and you previously called willNotifyOnAstChange(). */
    astDidChange: () => void;

    /** Set a meta result to be associated with this file. This value will be passed to the postProcess hook. */
    setMetaResult: (meta: TransformResultMeta) => void;
  }) => Promisable<GetPluginResult>;
})

// The `any` here is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TODO = any;

/**
 * An error with extra annotations indicating which part of the codemod it occurred in.
 */
export type PhaseError = Error & {
  /**
   * The name of the phase, like 'codemod.transform()'
   */
  phase: string;

  /**
   * A user-facing message giving a clue how to fix the issue.
   */
  suggestion: string;
}
