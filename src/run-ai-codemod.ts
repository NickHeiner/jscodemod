import { NTHLogger, LogMetadata } from 'nth-log';
import { makePhaseError } from './make-phase-error';
import {
  AICompletionCodemod,
  CodemodArgsWithSource,
  CodemodResult,
  AIPrompt,
  AIChatCodemod,
} from './types';
import type {
  OpenAI,
  ClientOptions
} from 'openai';
// eslint-disable-next-line no-duplicate-imports
import { OpenAI as OpenAIApi } from 'openai';
import _ from 'lodash';
import { defaultChatParams, defaultCompletionParams } from './default-completion-request-params';
import pDebounce from 'p-debounce';
import { EventEmitter } from 'events';
// @ts-expect-error
import { countTokens } from '@nick.heiner/gpt-3-encoder/Encoder';
import assert from 'assert';

const highlightRequestTimingLogic = false;

function getConfiguration() {
  const configuration: ClientOptions = {
    organization: getOrganizationId(),
    apiKey: getAPIKey(),
  };

  return configuration;
}

function getAPIKey() {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  throw new Error(
    // eslint-disable-next-line max-len
    'Env var `OPENAI_API_KEY` was not set. You must set it to your API key if you want to use an AI codemod. You can create an API key on https://beta.openai.com/account/api-keys.'
  );
}

function getOrganizationId() {
  if (process.env.OPENAI_ORG_ID) {
    return process.env.OPENAI_ORG_ID;
  }
  throw new Error(
    // eslint-disable-next-line max-len
    'Env var `OPENAI_ORG_ID` was not set. You must set it to your org ID if you want to use an AI codemod. You can find it on https://beta.openai.com/account/org-settings.'
  );
}

function defaultExtractResultFromCompletion(
  completion?:
    | Exclude<OpenAI.ChatCompletion['choices'][0]['message'], undefined>['content']
    | OpenAI.Completion['choices'][0]['text']
) {
  if (!completion) {
    throw makePhaseError(
      new Error('The AI returned a blank response.'),
      'extracting the transformed code from the completion',
      // eslint-disable-next-line max-len
      "Implement your own extractTransformationFromCompletion method, or repeat this call and see if you randomly get an output that doesn't trigger this issue."
    );
  }
  return completion;
}

function getCodemodTransformResult(
  codemod: AICompletionCodemod | AIChatCodemod,
  response: OpenAI.Completion | OpenAI.ChatCompletion
): CodemodResult<unknown> {
  if (codemod.extractTransformationFromCompletion) {
    if ('getMessages' in codemod && response.object === 'chat.completion') {
      return codemod.extractTransformationFromCompletion(response);
    } else if ('getPrompt' in codemod && response.object === 'text_completion') {
      return codemod.extractTransformationFromCompletion(response);
    }
  }
  const choice = response.choices[0];
  if ('message' in choice) {
    return defaultExtractResultFromCompletion(choice.message?.content);
  }

  return defaultExtractResultFromCompletion(choice.text);
}

interface OpenAIErrorResponse extends Error {
  response: {
    status: number;
    // eslint-disable-next-line id-blacklist
    data: {
      error: {
        message: string;
        type: string;
        param: unknown;
        code: unknown;
      };
    };
  };
}

const secondsPerMinute = 60;
const millisecondsPerSecond = 1000;

// TODO: Make all this configurable.
function getRetryTimeoutMs(attempt: number) {
  const baselineStepSize = 10_000;
  const minTimeoutMs = 2_000;
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  const maxTimeoutMs = 10 * secondsPerMinute * millisecondsPerSecond;

  // The higher this value is, the more each attempt will back off.
  const timeoutBase = 2.5;
  return Math.max(
    minTimeoutMs,
    Math.min(baselineStepSize * Math.random() * Math.pow(timeoutBase, attempt), maxTimeoutMs)
  );
}

type OpenAIAPIRateLimitedRequest = () => Promise<{ tokensUsed: number; rateLimitReached: boolean }>;
/**
 * This assumes that, at the beginning of program execution, you have full rate limit capacity. If you just finished
 * some other operation that used rate limit, then you immediately ran this program, this won't prevent you from hitting
 * the limit.
 *
 * The most common way I can think this would happen is if you ran a codemod, hit a rate limit, then immediately re-ran
 * the codemod.
 *
 * I think OpenAI's API is being a bit misleading in its error messages. It says things like:
 *    Limit: 40000.000000 / min. Current: 54190.000000 / min.
 *
 * However, at this point in the program, I've only used ~10k tokens in approximately 1 minute. In the near term, I can
 * get around this by setting a much lower rate limit. In the long term, I would like to either increase the rate limit,
 * or understand what the real limits are.
 */
export class OpenAIAPIRateLimiter {
  private readonly timeouts: Array<NodeJS.Timeout> = [];
  private readonly callRecords: Array<{ timeMs: number; tokensUsed: number }> = [];
  private openAIAPIAttemptRetryCount = 0;

  attemptCall: () => void;

  private setTimeout(fn: () => void, ms: number) {
    this.timeouts.push(setTimeout(fn, ms));
  }

  constructor(
    private log: NTHLogger,
    private readonly requestsPerMinuteLimit: number,
    private readonly tokensPerMinuteLimit: number,
    private readonly getNextRequest: () =>
      | {
          estimatedTokens: number;
          makeRequest: OpenAIAPIRateLimitedRequest;
        }
      | undefined
  ) {
    const rateLimitReciprocal = secondsPerMinute / requestsPerMinuteLimit;
    /**
     * I think this might be too conservative. We seem to be essentially making only one request at a time, and I think
     * this might be why. We're never actually hitting the rate limit branch in the logic in this class.
     *
     * Or the reason is that `innerAttemptCall` calls this debounced version, rather than calling itself.
     *
     * That said, in general, the OpenAI API has a very low rate limit, so even if this isn't the optimal way to
     * implement a slowdown, any slowdown is probably beneficial, so I'm not going to think about changing this now.
     */
    this.attemptCall = pDebounce(this.innerAttemptCall.bind(this), rateLimitReciprocal);
  }

  async innerAttemptCall(): Promise<void> {
    const nextRequest = this.getNextRequest();
    if (!nextRequest) {
      return;
    }

    const currentWindowStartTime = Date.now() - secondsPerMinute * millisecondsPerSecond;
    const callsInCurrentWindow = _.takeRightWhile(
      this.callRecords,
      ({ timeMs }) => timeMs >= currentWindowStartTime
    );
    const countCallsInCurrentWindow = callsInCurrentWindow.length;
    const hasExceededCallCountLimit = countCallsInCurrentWindow > this.requestsPerMinuteLimit;
    const tokensUsedInCurrentWindow = _.sumBy(callsInCurrentWindow, 'tokensUsed');
    const hasExceededTokenUseLimit = tokensUsedInCurrentWindow > this.tokensPerMinuteLimit;

    const loglevel = highlightRequestTimingLogic ? 'warn' : 'trace';

    if (hasExceededCallCountLimit || hasExceededTokenUseLimit) {
      const oldestCallRecord = callsInCurrentWindow[0];
      const timeUntilOldestCallRecordExpiresMs = oldestCallRecord.timeMs - currentWindowStartTime;
      this.log[loglevel](
        {
          hasExceededCallCountLimit,
          hasExceededTokenUseLimit,
          countCallsInCurrentWindow,
          tokensUsedInCurrentWindow,
          timeUntilOldestCallRecordExpiresMs,
        },
        "The local rate limiter shows we've reached rate limit. Waiting until the oldest call expires to try again."
      );
      this.setTimeout(this.attemptCall, timeUntilOldestCallRecordExpiresMs);
      return;
    }

    const countAllCalls = this.callRecords.length;
    const tokensUsedAllCalls = _.sumBy(this.callRecords, 'tokensUsed');

    this.log[loglevel](
      { countCallsInCurrentWindow, tokensUsedInCurrentWindow, countAllCalls, tokensUsedAllCalls },
      'Making request'
    );
    const callRecord = { timeMs: Date.now(), tokensUsed: nextRequest.estimatedTokens };
    this.callRecords.push(callRecord);
    const reqResult = await nextRequest.makeRequest();

    callRecord.tokensUsed = reqResult.tokensUsed;

    if (reqResult.rateLimitReached) {
      this.timeouts.forEach(clearTimeout);
      this.timeouts.length = 0;
      const retryTimeoutMs = getRetryTimeoutMs(this.openAIAPIAttemptRetryCount++);
      this.log[loglevel](
        { retryTimeoutMs, openAIAPIAttemptRetryCount: this.openAIAPIAttemptRetryCount },
        // eslint-disable-next-line max-len
        "OpenAI's response says we've reached rate limit. Cancelling other pending requests and exponentially backing off."
      );
      this.setTimeout(this.attemptCall, retryTimeoutMs);
    } else {
      this.openAIAPIAttemptRetryCount = 0;
      this.attemptCall();
    }
  }
}

function makeFileTooLargeError(
  maxTokensPerRequest: number,
  tokensRequiredToTransformThisFile: number,
  filePath: string
) {
  const err = new Error(
    /* eslint-disable max-len */
    `Could not transform file "${filePath}". It is too large. To address this:

1. Use the codemod's \`ignore\` API to ignore it.
2. Or split the file into smaller pieces.
3. Or use a model with a larger token limit.

You can read more about model limits at https://beta.openai.com/docs/models/overview. To see how many tokens your code is, see the tool at https://beta.openai.com/tokenizer. Your code must take up less than half the token limit of the model, because the token limit applies to both the input and the output, so we need to leave a headroom of 50% for the model to have room to respond.`
  );
  /* eslint-enable max-len */
  Object.assign(err, {
    maxTokensPerRequest,
    tokensRequiredToTransformThisFile,
  });
  return err;
}

/**
 * This gives the model headroom to return a codemodded file that's longer than our input file.
 * If you're expecting the model to transform your file by substantially increasing its length, you'll need this
 * value to be higher.
 */
const tokenSafetyMargin = 1.1;

function getEstimatedFullTokenCountNeededForRequestFromTokensInPrompt(tokensInPrompt: number) {
  return tokensInPrompt * 2;
}

class OpenAIBatchProcessor {
  private openai: OpenAI;
  private completionParams: OpenAI.CompletionCreateParamsNonStreaming;
  private batches: AIPrompt[][] = [];
  private log: NTHLogger;
  private successPerPromptEventEmitter = new EventEmitter();
  private failurePerPromptEventEmitter = new EventEmitter();

  // I've set these params to have substantial headroom, because the OpenAI API gives rate limit responses well below
  // the actual limits published online, or as indicated in the API responses themselves.
  //
  // TODO: configure all the rate limit params per model
  private readonly maxTokensPerRequest = 4096;
  private readonly maxTokensPerMinute = 10_000;
  private readonly openAIAPIRateLimitRequestsPerMinute = 5;

  private readonly rateLimiter: OpenAIAPIRateLimiter;

  constructor(log: NTHLogger, completionParams: OpenAI.CompletionCreateParamsNonStreaming) {
    this.log = log.child({ sourceCodeFile: undefined });
    this.completionParams = completionParams;

    this.openai = new OpenAIApi(getConfiguration());

    this.rateLimiter = new OpenAIAPIRateLimiter(
      this.log,
      this.openAIAPIRateLimitRequestsPerMinute,
      this.maxTokensPerMinute,
      this.handleRequestReady.bind(this)
    );
  }

  private getTokensForBatch(batch: AIPrompt[]) {
    const tokensInBatch = _.sumBy(batch, prompt => countTokens(prompt));
    return Math.ceil(tokensInBatch * tokenSafetyMargin);
  }

  private getOverheadForBatch(tokensInBatch: number) {
    return (
      this.maxTokensPerRequest -
      getEstimatedFullTokenCountNeededForRequestFromTokensInPrompt(tokensInBatch)
    );
  }

  private addPrompt(prompt: AIPrompt, filePath: string) {
    const log = this.log.child({ method: 'OpenAIBatchProcessor#addPrompt' });

    const addNewBatch = () => {
      const newBatch = [prompt];
      const tokensInNewBatch = this.getTokensForBatch(newBatch);
      const overheadRemainingInNewestBatch = this.getOverheadForBatch(tokensInNewBatch);
      if (overheadRemainingInNewestBatch < 0) {
        throw makeFileTooLargeError(this.maxTokensPerRequest, tokensInNewBatch, filePath);
      } else {
        this.batches.push([prompt]);
      }
    };

    log.trace('Adding prompt to batch');
    if (!this.batches.length) {
      addNewBatch();
      return;
    }
    // This is safe because of the length check above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const mostRecentBatch = _.last(this.batches)!;
    const tokensInMostRecentBatch = this.getTokensForBatch(mostRecentBatch);
    const overheadRemainingInMostRecentBatch = this.getOverheadForBatch(tokensInMostRecentBatch);
    const tokensForLatestPrompt = countTokens(prompt);
    log.trace({
      tokensForLatestPrompt,
      overheadRemainingInMostRecentBatch,
      tokensInMostRecentBatch,
    });
    if (tokensForLatestPrompt > overheadRemainingInMostRecentBatch) {
      addNewBatch();
    } else {
      log.trace('Adding to existing batch');
      mostRecentBatch.push(prompt);
    }
  }

  complete(prompt: AIPrompt, filePath: string): Promise<OpenAI.Completion> {
    this.log.trace({ prompt }, 'Adding prompt to batch');
    this.addPrompt(prompt, filePath);
    this.rateLimiter.attemptCall();
    return new Promise((resolve, reject) => {
      this.successPerPromptEventEmitter.once(prompt, resolve);
      this.failurePerPromptEventEmitter.once(prompt, reason => {
        reject(reason);
      });
    });
  }

  private async makeRequestForBatch(batch: AIPrompt[], maxTokens: number) {
    const completionRequestParams = {
      ...this.completionParams,
      prompt: batch,
      // eslint-disable-next-line camelcase
      max_tokens: maxTokens,
    };
    const logMetadata = highlightRequestTimingLogic
      ? ({
          level: 'warn',
          filesInBatch: batch.length,
        } satisfies LogMetadata)
      : ({
          level: 'debug',
          completionRequestParams,
        } satisfies LogMetadata);
    const completions = await this.log.logPhase(
      { phase: 'OpenAI request', ...logMetadata },
      async (_, setAdditionalLogData) => {
        const completions = await this.openai.completions.create(completionRequestParams);
        if (!highlightRequestTimingLogic) {
          setAdditionalLogData({ completionResponse: completions });
        }
        return completions;
      }
    );

    // Doing this will cause a single error to appear multiple times in the output. If you have three files in a batch,
    // and that batch fails with a single error, each file will be marked as failed on account of that error, so the
    // error will be printed out three times.
    batch.forEach((prompt, index) => {
      if (completions instanceof Error || 'error' in completions) {
        this.failurePerPromptEventEmitter.emit(prompt, completions);
        return;
      }

      const completion = completions.choices[index];
      const completionWithOnlyThisChoice = {
        ...completions,
        choices: [completion],
      };
      this.log.trace({ completion, prompt });
      this.successPerPromptEventEmitter.emit(prompt, completionWithOnlyThisChoice);
    });

    return completions;
  }

  private handleRequestReady(): ReturnType<OpenAIAPIRateLimiter['getNextRequest']> {
    if (!this.completionParams) {
      throw new Error('Internal error: Completion params not set');
    }
    if (!this.batches.length) {
      return;
    }
    // This is safe because of the length check above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const batchForRequest = this.batches.shift()!;
    const tokensInBatch = this.getTokensForBatch(batchForRequest);
    const maxTokens = this.maxTokensPerRequest - tokensInBatch;
    assert(maxTokens >= 0, 'Bug in jscodemod: maxTokens is negative');

    const estimatedTokens =
      getEstimatedFullTokenCountNeededForRequestFromTokensInPrompt(tokensInBatch);

    return {
      estimatedTokens,
      makeRequest: async () => {
        let tokensUsed = estimatedTokens;
        let rateLimitReached = false;
        try {
          const completions = await this.makeRequestForBatch(batchForRequest, maxTokens);
          tokensUsed = completions.usage?.total_tokens || tokensUsed;
        } catch (e: unknown) {
          const responseIsError = e && typeof e === 'object' && 'response' in e;
          if (!responseIsError) {
            this.log.error(
              { err: e },
              // eslint-disable-next-line max-len
              "OpenAI request failed. This could indicate a bug in jscodemod. This error doesn't necessarily mean the entire codemod run failed; if some files were successfully transformed, you can save them before trying again."
            );
            throw e;
          }
          const openAIErrorResponse = e as OpenAIErrorResponse;
          rateLimitReached =
            openAIErrorResponse.response.data.error.message.includes('Rate limit reached') ||
            /* eslint-disable max-len */
            /**
             * One possible error response from the API:
             * {
                  "error": {
                    "message": "That model is currently overloaded with other requests. You can retry your request, or contact us through our help center at help.openai.com if the error persists. (Please include the request ID b99bb8c4404d91ba7a7a60bd0bfe6d9a in your message.)",
                    "type": "server_error",
                    "param": null,
                    "code": null
                  }
                }
             */
            /* eslint-enable max-len */
            openAIErrorResponse.response.data.error.message.includes(
              'That model is currently overloaded with other requests.'
            );
          if (rateLimitReached) {
            this.log[highlightRequestTimingLogic ? 'warn' : 'debug']({
              openAIResponseMessage: openAIErrorResponse.response.data.error.message,
            });
          } else {
            const error = new Error(openAIErrorResponse.response.data.error.message);
            error.cause = e;
            throw e;
          }
        }

        if (rateLimitReached) {
          this.batches.push(batchForRequest);
        }

        return {
          tokensUsed,
          rateLimitReached,
        };
      },
    };
  }
}

const createOpenAIBatchProcessor = _.once(
  (log: NTHLogger, completionParams: OpenAI.CompletionCreateParamsNonStreaming) =>
    new OpenAIBatchProcessor(log, completionParams)
);

const getCompletionRequestParams = _.once(
  (codemod: AICompletionCodemod, codemodOpts: CodemodArgsWithSource) =>
    codemod.getGlobalAPIRequestParams
      ? codemod.getGlobalAPIRequestParams(_.omit(codemodOpts))
      : defaultCompletionParams
);

const getChatRequestParams = _.once((codemod: AIChatCodemod, codemodOpts: CodemodArgsWithSource) =>
  codemod.getGlobalAPIRequestParams
    ? codemod.getGlobalAPIRequestParams(_.omit(codemodOpts))
    : defaultChatParams
);

async function runAICompletionCodemod(
  codemod: AICompletionCodemod,
  codemodOpts: CodemodArgsWithSource,
  log: NTHLogger
) {
  let completionParams: OpenAI.CompletionCreateParamsNonStreaming;
  try {
    completionParams = await getCompletionRequestParams(codemod, codemodOpts) as OpenAI.CompletionCreateParamsNonStreaming;
  } catch (e: unknown) {
    throw makePhaseError(
      e as Error,
      'codemod.getCompletionRequestParams()',
      "Check your getCompletionRequestParams() method for a bug, or add this file to your codemod's ignore list."
    );
  }
  const openAIBatchProcessor = createOpenAIBatchProcessor(log, completionParams);

  let prompt: AIPrompt;
  try {
    prompt = await codemod.getPrompt(codemodOpts.source);
  } catch (e: unknown) {
    throw makePhaseError(
      e as Error,
      'codemod.getPrompt()',
      "Check your getCompletionRequestParams() method for a bug, or add this file to your codemod's ignore list."
    );
  }

  const result = await openAIBatchProcessor.complete(prompt, codemodOpts.filePath);

  return getCodemodTransformResult(codemod, result);
}

async function getAIChatCodemodParams(codemod: AIChatCodemod, codemodOpts: CodemodArgsWithSource) {
  let chatCompletionParams: OpenAI.ChatCompletionCreateParamsNonStreaming;
  try {
    const paramsWithoutMessages = await getChatRequestParams(codemod, codemodOpts);
    chatCompletionParams = {
      ..._.cloneDeep(paramsWithoutMessages),
      messages: [],
    };
  } catch (e: unknown) {
    throw makePhaseError(
      e as Error,
      'codemod.getChatRequestParams()',
      "Check your getChatRequestParams() method for a bug, or add this file to your codemod's ignore list."
    );
  }

  let messages: ReturnType<typeof codemod.getMessages>;
  try {
    messages = await codemod.getMessages(codemodOpts.source);
  } catch (e: unknown) {
    throw makePhaseError(
      e as Error,
      'codemod.getMessages()',
      "Check your getMessages() method for a bug, or add this file to your codemod's ignore list."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  const maxTotalTokens = chatCompletionParams.max_tokens ?? 4096;
  chatCompletionParams.messages.push(...messages);

  const tokensForMessages = _(messages)
    .map('content')
    .sumBy(content => countTokens(content));
  const tokensNeeded =
    getEstimatedFullTokenCountNeededForRequestFromTokensInPrompt(tokensForMessages) *
    tokenSafetyMargin;
  if (tokensNeeded > maxTotalTokens) {
    throw makeFileTooLargeError(maxTotalTokens, tokensNeeded, codemodOpts.filePath);
  }
  // eslint-disable-next-line camelcase
  chatCompletionParams.max_tokens = Math.ceil(maxTotalTokens - tokensForMessages);

  return chatCompletionParams;
}

async function runAIChatCodemod(
  codemod: AIChatCodemod,
  codemodOpts: CodemodArgsWithSource,
  log: NTHLogger
) {
  const chatCompletionParams = await getAIChatCodemodParams(codemod, codemodOpts);

  const openai = new OpenAIApi(getConfiguration());
  log.trace({ chatCompletionParams });

  // Incredibly hacky "rate limiter"
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers
  await new Promise(resolve => setTimeout(resolve, 10000 * Math.random()));

  const completion = await openai.chat.completions.create(chatCompletionParams);

  return getCodemodTransformResult(codemod, completion);
}

export default function runAICodemod(
  codemod: AICompletionCodemod | AIChatCodemod,
  codemodOpts: CodemodArgsWithSource,
  log: NTHLogger
) {
  if ('getMessages' in codemod) {
    return runAIChatCodemod(codemod, codemodOpts, log);
  }
  return runAICompletionCodemod(codemod, codemodOpts, log);
}

export const __test = {
  getAIChatCodemodParams,
};
