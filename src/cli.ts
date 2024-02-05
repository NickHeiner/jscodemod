// This is a bin file, so console logs are ok.
/* eslint-disable no-console */

import yargs from 'yargs';
import jscodemod, { defaultPiscinaLowerBoundInclusive, Options } from './';
import _ from 'lodash';
import 'loud-rejection/register';
import getLogger from './get-logger';
import { CodemodMetaResult } from './run-codemod-on-file';
import PrettyError from 'pretty-error';
import ansiColors from 'ansi-colors';
import path from 'path';
import { sync as loadJsonFileSync } from 'load-json-file';
import fs from 'fs';
import type { OpenAI } from 'openai';
import { defaultCompletionParams, defaultChatParams } from './default-completion-request-params';

const builtInCodemods = {
  'js-to-ts': require.resolve('./js-to-ts-codemod'),
};

// Passing paths as file globs that start with `.` doesn't work.
// https://github.com/sindresorhus/globby/issues/168

const yargsChain = yargs
  // TODO: Some of these options should be hidden.
  .command(
    /**
     * I feel like '$0 [options] [inputFilePatterns...] is what want, but that breaks things. It's not obvious how yargs
     * parses this string.
     */
    '$0 [inputFilesPatterns...]',
    'Run the codemod. Any arguments after "--" will be passed through to the codemod.',
    yargs => {
      yargs
        .positional('inputFilesPatterns', {
          type: 'string',
        })
        .example([
          ['$0 --codemod codemod.js "source/**/*.js"', 'Run codemod.js against JS files in source'],
          [
            '$0 --codemod codemod.js --inputFileList files-to-modify.txt',
            'Run the codemod against a set of files listed in the text file.',
          ],
          [
            '$0 --completionPrompt "Translate the file above from ES5 to modern JS" "source/**/*.js"',
            'Run an AI-powered codemod against the files matching the passed glob.',
          ],
        ]);
    }
  )
  .middleware(argv => {
    argv.codemodArgs = argv['--'];
  }, true)
  .options({
    codemod: {
      alias: 'c',
      type: 'string',
      describe: 'Path to the codemod to run',
    },
    builtInCodemod: {
      type: 'string',
      describe: 'The built-in codemod to run',
      choices: Object.keys(builtInCodemods),
    },
    inputFileList: {
      alias: 'l',
      type: 'string',
      describe: 'A file containing a newline-delimited set of file paths to run on',
    },
    // TODO: allow arbitrary TS arg passthrough at your own risk.
    tsconfig: {
      type: 'string',
      describe: 'path to the tsconfig.json',
    },
    // I'm going to skip adding tests for this for now, because I'm not sure it's actually necessary.
    tsOutDir: {
      type: 'string',
      describe: 'directory in which to compile your codemod to. Defaults to a temporary directory.',
    },
    tsc: {
      type: 'string',
      describe:
        'path to a "tsc" executable to compile your codemod. ' +
        'Defaults to looking for a "tsc" bin accessible from the current working directory.',
    },
    dry: {
      alias: 'd',
      type: 'boolean',
      describe: 'Print a list of files to modify, then stop.',
    },
    piscinaLowerBoundInclusive: {
      alias: 'b',
      type: 'number',
      default: defaultPiscinaLowerBoundInclusive,
      describe:
        'Only use piscina if there are at least this many files. At smaller file sizes, the fixed cost of ' +
        'spinning up piscina outweighs the benefits.',
    },
    porcelain: {
      alias: 'p',
      default: false,
      type: 'boolean',
      describe: 'Produce machine-readable output.',
    },
    codemodArgs: {
      type: 'string',
      hidden: true,
      describe: 'Do not pass this argument. This is only here to make yargs happy.',
    },
    resetDirtyInputFiles: {
      alias: 'r',
      type: 'boolean',
      default: false,
      describe:
        'Use git to restore dirty files to a clean state before running the codemod. ' +
        'This assumes that all input files have the same .git root. If you use submodules, this may not work.',
    },
    jsonOutput: {
      type: 'boolean',
      default: false,
      describe:
        'Output logs as JSON, instead of human-readable formatting. Useful if you want to consume the output ' +
        'of this tool from another tool, or process the logs using your own Bunyan log processor/formatter. The ' +
        'precise set of logs emitted is not considered to be part of the public API.',
    },
    completionPrompt: {
      type: 'string',
      required: false,
      // eslint-disable-next-line max-len
      describe:
        "A prompt for an AI-powered codemod. The AI will be asked to complete an input. The input will be form: `${input file source code}\n//${the value you pass for this flag}`. If that format doesn't work for you, implement an AICodemod instead and pass the --codemod flag.",
      conflicts: ['codemod'],
    },
    completionPromptFile: {
      type: 'string',
      required: false,
      // eslint-disable-next-line max-len
      describe:
        "A prompt for an AI-powered codemod. The AI will be asked to complete an input. The input will be form: `${input file source code}\n//${the contents of the file pointed to by this flag}`. If that format doesn't work for you, implement an AICodemod instead and pass the --codemod flag.",
      conflicts: ['completionPrompt', 'codemod'],
    },
    openAICompletionRequestConfig: {
      required: false,
      type: 'string',
      conflicts: ['codemod'],
      describe:
        // eslint-disable-next-line max-len
        "API params to pass to OpenAI's OpenAI.CompletionCreateParams API. See https://beta.openai.com/docs/api-reference/completions/create. The argument you pass to this flag will be interpreted as JSON.",
    },
    openAICompletionRequestFile: {
      required: false,
      type: 'string',
      conflicts: ['openAICompletionRequestConfig', 'codemod'],
      describe:
        // eslint-disable-next-line max-len
        "A path to a JSON file containing request params for OpenAI's OpenAI.CompletionCreateParams API. See https://beta.openai.com/docs/api-reference/completions/create.",
    },
    chatMessage: {
      type: 'string',
      required: false,
      // eslint-disable-next-line max-len
      describe:
        "A prompt for an AI-powered codemod. The AI will be sent the code file to transform as a message, and then whatever you pass for this flag. If that format doesn't work for you, implement an AICodemod instead and pass the --codemod flag.",
      conflicts: ['codemod', 'completionPrompt', 'completionPromptFile'],
    },
    chatMessageFile: {
      type: 'string',
      required: false,
      // eslint-disable-next-line max-len
      describe:
        "A prompt for an AI-powered codemod.  The AI will be sent the code file to transform as a message, and then the contents of the filepath you pass for this flag. If that format doesn't work for you, implement an AICodemod instead and pass the --codemod flag.",
      conflicts: ['chatMessage', 'codemod', 'completionPrompt', 'completionPromptFile'],
    },
    openAIChatRequestConfig: {
      required: false,
      type: 'string',
      conflicts: ['codemod'],
      describe:
        // eslint-disable-next-line max-len
        "API params to pass to OpenAI's chat API. See https://beta.openai.com/docs/api-reference/chat/create. The argument you pass to this flag will be interpreted as JSON.",
    },
    openAIChatRequestFile: {
      required: false,
      type: 'string',
      conflicts: ['openAICompletionRequestConfig', 'openAIChatRequestConfig', 'codemod'],
      describe:
        // eslint-disable-next-line max-len
        "A path to a JSON file containing request params for OpenAI's chat API. See https://beta.openai.com/docs/api-reference/chat/create.",
    },
  })
  .group(['codemod', 'dry', 'resetDirtyInputFiles', 'inputFileList'], 'Primary')
  .group(
    ['prompt', 'promptFile', 'openAICompletionRequestConfig', 'openAICompletionRequestFile'],
    // eslint-disable-next-line max-len
    `AI (Completion). Only applicable if you're using AI for your codemod. See ${path.resolve(
      __filename,
      path.join('..', '..', 'docs', 'ai.md')
    )}.`
  )
  .group(
    ['chatMessage', 'chatMessageFile', 'openAIChatRequestConfig', 'openAIChatRequestFile'],
    // eslint-disable-next-line max-len
    `AI (chatGPT). Only applicable if you're using AI for your codemod. See ${path.resolve(
      __filename,
      path.join('..', '..', 'docs', 'ai.md')
    )}.`
  )
  .group(
    ['tsconfig', 'tsOutDir', 'tsc'],
    'TypeScript (only applicable if your codemod is written in TypeScript)'
  )
  .group(['jsonOutput', 'porcelain'], 'Rarely Useful')
  .check(argv => {
    const log = getLogger(_.pick(argv, 'jsonOutput', 'porcelain'));
    log.debug({ argv });

    // Yarg's types are messed up.
    // @ts-expect-error
    if (!((argv.inputFilesPatterns && argv.inputFilesPatterns.length) || argv.inputFileList)) {
      throw new Error(
        'You must pass at least one globby pattern of files to transform, or an --inputFileList.'
      );
    }
    // Yarg's types are messed up.
    // @ts-expect-error
    if (argv.inputFilesPatterns && argv.inputFilesPatterns.length && argv.inputFileList) {
      throw new Error("You can't pass both an --inputFileList and a globby pattern.");
    }
    if (argv.porcelain && !argv.dry) {
      throw new Error('Porcelain is only supported for dry mode.');
    }

    const aiRequestParams = validateAndGetRequestParams(argv);
    if (
      !(
        argv.codemod ||
        argv.builtInCodemod ||
        (aiRequestParams && ('messages' in aiRequestParams || 'prompt' in aiRequestParams))
      )
    ) {
      throw new Error(
        'You must pass either the --codemod, --builtInCodemod, --prompt, or --chatMessage flags.'
      );
    }

    return true;
  })
  .strict()
  .help();

type Args = ReturnType<(typeof yargsChain)['parseSync']>;

export function validateAndGetRequestParams({
  openAICompletionRequestConfig,
  openAICompletionRequestFile,
  completionPromptFile,
  chatMessageFile,
  completionPrompt,
  chatMessage,
  openAIChatRequestConfig,
  openAIChatRequestFile,
}: Pick<
  Args,
  | 'openAICompletionRequestConfig'
  | 'openAICompletionRequestFile'
  | 'completionPromptFile'
  | 'chatMessageFile'
  | 'completionPrompt'
  | 'chatMessage'
  | 'openAIChatRequestConfig'
  | 'openAIChatRequestFile'
>): OpenAI.CompletionCreateParamsNonStreaming | OpenAI.ChatCompletionCreateParamsNonStreaming | undefined {
  const isChatCodemod =
    chatMessage || chatMessageFile || openAIChatRequestFile || openAIChatRequestConfig;
  const isCompletionCodemod =
    completionPrompt ||
    completionPromptFile ||
    openAICompletionRequestFile ||
    openAICompletionRequestConfig;

  function validateAndGetAIOptsForCodemodKind(
    prompt: Args['completionPrompt'] | Args['chatMessage'],
    promptFilePath: Args['completionPromptFile'] | Args['chatMessageFile'],
    requestConfig: Args['openAICompletionRequestConfig'] | Args['openAIChatRequestConfig'],
    requestConfigFile: Args['openAICompletionRequestFile'] | Args['openAIChatRequestFile'],
    defaultConfig: typeof defaultCompletionParams | typeof defaultChatParams
  ): OpenAI.ChatCompletionCreateParamsNonStreaming | OpenAI.CompletionCreateParamsNonStreaming {
    const promptFromFile = promptFilePath && fs.readFileSync(promptFilePath, 'utf8');
    const promptFromFlags = promptFromFile || prompt;

    let requestParams = _.cloneDeep(defaultConfig);
    if (requestConfig) {
      requestParams = JSON.parse(requestConfig);
    } else if (requestConfigFile) {
      requestParams = loadJsonFileSync(requestConfigFile);
    }

    if (promptFromFlags && ('prompt' in requestParams || 'messages' in requestParams)) {
      throw new Error(
        // eslint-disable-next-line max-len
        'If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags.'
      );
    }

    if (isChatCodemod) {
      (requestParams as OpenAI.ChatCompletionCreateParamsNonStreaming).messages = [
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        { role: 'user', content: promptFromFlags! },
      ];
    } else {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      (requestParams as OpenAI.CompletionCreateParamsNonStreaming).prompt = promptFromFlags!;
    }

    return requestParams as OpenAI.ChatCompletionCreateParamsNonStreaming | OpenAI.CompletionCreateParamsNonStreaming;
  }

  if (isChatCodemod) {
    return validateAndGetAIOptsForCodemodKind(
      chatMessage,
      chatMessageFile,
      openAIChatRequestConfig,
      openAIChatRequestFile,
      defaultChatParams
    );
  }
  if (isCompletionCodemod) {
    return validateAndGetAIOptsForCodemodKind(
      completionPrompt,
      completionPromptFile,
      openAICompletionRequestConfig,
      openAICompletionRequestFile,
      defaultCompletionParams
    );
  }
  return undefined;
}

/**
 * It's a little spooky to have this live here, rather than the place where the errors are created. However, I only want
 * to remove some fields for the purpose of logging to the console, so I don't want it to impact programmatic callers.
 *
 * If this becomes painful, I could have the error production site put a method on the error called
 * "getFieldsForLogging" or something.
 */
function getErrorFieldsForLogging(error: Record<string, unknown>) {
  if (error.isAxiosError) {
    return _.pick(error.response, 'status', 'statusText', 'headers', 'data');
  }
  return error;
}

export async function main() {
  const argv = yargsChain.parseSync();
  const log = getLogger(_.pick(argv, 'jsonOutput', 'porcelain'));

  // This is not an exhaustive error wrapper, but I think it's ok for now. Making it catch more cases would introduce
  // complexity without adding much safety.
  try {
    // @ts-expect-error I'm not sure how to make this work with `inputFileList` and `inputFilesPatterns`.
    const opts: Options = {
      ..._.pick(
        argv,
        'tsconfig',
        'tsOutDir',
        'tsc',
        'dry',
        'resetDirtyInputFiles',
        'porcelain',
        'jsonOutput',
        'piscinaLowerBoundInclusive',
        'inputFileList',
        'inputFilesPatterns'
      ),
      openAIAPIRequestParams: validateAndGetRequestParams(argv),
      log,
    };

    // This is intentional.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function safeConsoleLog(...args: any[]) {
      if (opts.jsonOutput || opts.porcelain) {
        return;
      }

      console.log(...args);
    }

    Object.assign(opts, _.pick(argv, 'codemodArgs'));

    // TODO: validate that `builtInCodemod` is a real codemod.
    // @ts-expect-error
    const codemodPath = argv.builtInCodemod ? builtInCodemods[argv.builtInCodemod] : argv.codemod;

    const codemodMetaResults = await jscodemod(codemodPath, opts);

    const erroredFiles = _(codemodMetaResults)
      .filter({ action: 'error' })
      .map((result: CodemodMetaResult<unknown>) => _.omit(result, 'fileContents'))
      .value();
    if (erroredFiles.length) {
      if (opts.jsonOutput) {
        log.error({ erroredFiles }, 'The codemod threw errors for some files.');
      } else {
        const prettyError = new PrettyError();
        safeConsoleLog(
          ansiColors.bold(
            'The codemod threw errors for some files. This does not stop other files from being transformed.'
          )
        );
        // Lodash's types are messed up.
        // @ts-expect-error
        erroredFiles.forEach(({ error, filePath }) => {
          safeConsoleLog('For file: ', filePath);
          safeConsoleLog(getErrorFieldsForLogging(_.pick(error, Object.keys(error))));
          safeConsoleLog(prettyError.render(error));
        });
      }

      process.exit(1);
    }

    log.debug({ codemodMetaResults });
  } catch (err) {
    // TODO: Maybe known errors should be marked with a flag, since showing a stack trace for them probably
    // is just noise.
    log.error(
      { err },
      err instanceof Error ? err.message : 'Potential bug in jscodemod: uncaught error.'
    );
    if (!argv.jsonOutput) {
      // This is intentional.
      // eslint-disable-next-line no-console
      console.log(err);
    }
    log.info(
      "If you need help, please see this project's README, or the --help output. " +
        "If you're filing a bug report, please re-run this command with env var 'loglevel=debug', and provide the " +
        'full output.'
    );
    process.exit(1);
  }
}
