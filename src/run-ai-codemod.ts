import {NTHLogger, LogMetadata} from 'nth-log';
import {makePhaseError} from './make-phase-error';
import {AICodemod, CodemodArgsWithSource, CodemodResult, AIPrompt} from './types';
import {Configuration, OpenAIApi, CreateCompletionResponse, CreateCompletionRequest} from 'openai';
import _ from 'lodash';
import defaultCompletionRequestParams from './default-completion-request-params';
import pDebounce from 'p-debounce';
import {EventEmitter} from 'events';
// @ts-expect-error
import {countTokens} from '@nick.heiner/gpt-3-encoder/Encoder';
import assert from 'assert';

const highlightRequestTimingLogic = false;

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
  completion: CreateCompletionResponse['choices'][0]['text']
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
  codemod: AICodemod,
  response: CreateCompletionResponse
): CodemodResult<unknown> {
  if (codemod.extractTransformationFromCompletion) {
    return codemod.extractTransformationFromCompletion(response);
  }
  return defaultExtractResultFromCompletion(response.choices[0].text);
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
      }
    }
  }
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

type OpenAIAPIRateLimitedRequest = () => Promise<{tokensUsed: number, rateLimitReached: boolean}>
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
  private readonly callRecords: Array<{timeMs: number, tokensUsed: number}> = [];
  private openAIAPIAttemptRetryCount = 0;

  attemptCall: () => void;

  private setTimeout(fn: () => void, ms: number) {
    this.timeouts.push(setTimeout(fn, ms));
  }

  constructor(
    private log: NTHLogger,
    private readonly requestsPerMinuteLimit: number,
    private readonly tokensPerMinuteLimit: number,
    private readonly getNextRequest: () => {
      estimatedTokens: number, makeRequest: OpenAIAPIRateLimitedRequest
    } | undefined
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

    const currentWindowStartTime = Date.now() - (secondsPerMinute * millisecondsPerSecond);
    const callsInCurrentWindow = _.takeRightWhile(this.callRecords, ({timeMs}) => timeMs >= currentWindowStartTime);
    const countCallsInCurrentWindow = callsInCurrentWindow.length;
    const hasExceededCallCountLimit = countCallsInCurrentWindow > this.requestsPerMinuteLimit;
    const tokensUsedInCurrentWindow = _.sumBy(callsInCurrentWindow, 'tokensUsed');
    const hasExceededTokenUseLimit = tokensUsedInCurrentWindow > this.tokensPerMinuteLimit;

    const loglevel = highlightRequestTimingLogic ? 'warn' : 'trace';

    if (hasExceededCallCountLimit || hasExceededTokenUseLimit) {
      const oldestCallRecord = callsInCurrentWindow[0];
      const timeUntilOldestCallRecordExpiresMs = oldestCallRecord.timeMs - currentWindowStartTime;
      this.log[loglevel]({
        hasExceededCallCountLimit,
        hasExceededTokenUseLimit,
        countCallsInCurrentWindow,
        tokensUsedInCurrentWindow,
        timeUntilOldestCallRecordExpiresMs
      }, "The local rate limiter shows we've reached rate limit. Waiting until the oldest call expires to try again.");
      this.setTimeout(this.attemptCall, timeUntilOldestCallRecordExpiresMs);
      return;
    }

    const countAllCalls = this.callRecords.length;
    const tokensUsedAllCalls = _.sumBy(this.callRecords, 'tokensUsed');

    this.log[loglevel](
      {countCallsInCurrentWindow, tokensUsedInCurrentWindow, countAllCalls, tokensUsedAllCalls},
      'Making request'
    );
    const callRecord = {timeMs: Date.now(), tokensUsed: nextRequest.estimatedTokens};
    this.callRecords.push(callRecord);
    const reqResult = await nextRequest.makeRequest();

    callRecord.tokensUsed = reqResult.tokensUsed;

    if (reqResult.rateLimitReached) {
      this.timeouts.forEach(clearTimeout);
      this.timeouts.length = 0;
      const retryTimeoutMs = getRetryTimeoutMs(this.openAIAPIAttemptRetryCount++);
      this.log[loglevel](
        {retryTimeoutMs, openAIAPIAttemptRetryCount: this.openAIAPIAttemptRetryCount},
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

class OpenAIBatchProcessor {
  private openai: OpenAIApi;
  private completionParams: CreateCompletionRequest;
  private batches: AIPrompt[][] = [];
  private log: NTHLogger;
  private successPerPromptEventEmitter = new EventEmitter();
  private failurePerPromptEventEmitter = new EventEmitter();

  /**
   * This gives the model headroom to return a codemodded file that's longer than our input file.
   * If you're expecting the model to transform your file by substantially increasing its length, you'll need this
   * value to be higher.
   */
  private readonly tokenSafetyMargin = 1.1;

  // I've set these params to have substantial headroom, because the OpenAI API gives rate limit responses well below
  // the actual limits published online, or as indicated in the API responses themselves.
  //
  // TODO: configure all the rate limit params per model
  private readonly maxTokensPerRequest = 4096;
  private readonly maxTokensPerMinute = 10_000;
  private readonly openAIAPIRateLimitRequestsPerMinute = 5;

  private readonly rateLimiter: OpenAIAPIRateLimiter;

  constructor(log: NTHLogger, completionParams: CreateCompletionRequest) {
    this.log = log.child({sourceCodeFile: undefined});
    this.completionParams = completionParams;

    const configuration = new Configuration({
      organization: getOrganizationId(),
      apiKey: getAPIKey()
    });

    this.openai = new OpenAIApi(configuration);

    this.rateLimiter = new OpenAIAPIRateLimiter(
      this.log,
      this.openAIAPIRateLimitRequestsPerMinute,
      this.maxTokensPerMinute,
      this.handleRequestReady.bind(this)
    );
  }

  private getTokensForBatch(batch: AIPrompt[]) {
    const tokensInBatch = _.sumBy(batch, prompt => countTokens(prompt));
    return Math.ceil(tokensInBatch * this.tokenSafetyMargin);
  }

  private getEstimatedFullTokenCountNeededForRequestFromTokensInPrompt(tokensInPrompt: number) {
    return tokensInPrompt * 2;
  }

  private getOverheadForBatch(tokensInBatch: number) {
    return this.maxTokensPerRequest - this.getEstimatedFullTokenCountNeededForRequestFromTokensInPrompt(tokensInBatch);
  }

  private addPrompt(prompt: AIPrompt, filePath: string) {
    const log = this.log.child({method: 'OpenAIBatchProcessor#addPrompt'});
    log.trace('Adding prompt to batch');
    if (!this.batches.length) {
      log.trace('Creating new batch because there are no batches');
      this.batches.push([prompt]);
      return;
    }
    // This is safe because of the length check above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const mostRecentBatch = _.last(this.batches)!;
    const tokensInMostRecentBatch = this.getTokensForBatch(mostRecentBatch);
    const overheadRemainingInMostRecentBatch = this.getOverheadForBatch(tokensInMostRecentBatch);
    const tokensForLatestPrompt = countTokens(prompt);
    log.trace({tokensForLatestPrompt, overheadRemainingInMostRecentBatch, tokensInMostRecentBatch});
    if (tokensForLatestPrompt > overheadRemainingInMostRecentBatch) {
      const newBatch = [prompt];
      const tokensInNewBatch = this.getTokensForBatch(newBatch);
      const overheadRemainingInNewestBatch = this.getOverheadForBatch(tokensInNewBatch);
      if (overheadRemainingInNewestBatch < 0) {
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
          maxTokensPerRequest: this.maxTokensPerRequest,
          tokensRequiredToTransformThisFile: tokensInNewBatch
        });
        throw err;
      } else {
        log.trace('Creating new batch');
        this.batches.push([prompt]);
      }
    } else {
      log.trace('Adding to existing batch');
      mostRecentBatch.push(prompt);
    }
  }

  complete(prompt: AIPrompt, filePath: string): Promise<CreateCompletionResponse> {
    this.log.trace({prompt}, 'Adding prompt to batch');
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
      max_tokens: maxTokens
    };
    const logMetadata = highlightRequestTimingLogic ? {
      level: 'warn',
      filesInBatch: batch.length
    } satisfies LogMetadata : {
      level: 'debug',
      completionRequestParams
    } satisfies LogMetadata;
    const axiosResponse = await this.log.logPhase(
      {phase: 'OpenAI request', ...logMetadata},
      async (_, setAdditionalLogData) => {
        const response = await this.openai.createCompletion(completionRequestParams);
        if (!highlightRequestTimingLogic) {
          setAdditionalLogData({completionResponse: response.data});
        }
        return response;
      }
    );

    // Doing this will cause a single error to appear multiple times in the output. If you have three files in a batch,
    // and that batch fails with a single error, each file will be marked as failed on account of that error, so the
    // error will be printed out three times.
    batch.forEach((prompt, index) => {
      if (axiosResponse instanceof Error || 'error' in axiosResponse) {
        this.failurePerPromptEventEmitter.emit(prompt, axiosResponse);
        return;
      }

      const completion = axiosResponse.data.choices[index];
      const completionWithOnlyThisChoice = {
        ...axiosResponse.data,
        choices: [completion]
      };
      this.log.trace({completion, prompt});
      this.successPerPromptEventEmitter.emit(prompt, completionWithOnlyThisChoice);
    });

    return axiosResponse;
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

    const estimatedTokens = this.getEstimatedFullTokenCountNeededForRequestFromTokensInPrompt(tokensInBatch);

    return {
      estimatedTokens,
      makeRequest: async () => {
        let tokensUsed = estimatedTokens;
        let rateLimitReached = false;
        try {
          const axiosResponse = await this.makeRequestForBatch(batchForRequest, maxTokens);
          tokensUsed = axiosResponse.data.usage?.total_tokens || tokensUsed;
        } catch (e: unknown) {
          const responseIsError = e && typeof e === 'object' && 'response' in e;
          if (!responseIsError) {
            this.log.error(
              {err: e},
              // eslint-disable-next-line max-len
              "OpenAI request failed. This could indicate a bug in jscodemod. This error doesn't necessarily mean the entire codemod run failed; if some files were successfully transformed, you can save them before trying again."
            );
            throw e;
          }
          const openAIErrorResponse = e as OpenAIErrorResponse;
          rateLimitReached =
            (openAIErrorResponse.response.data.error.message.includes('Rate limit reached') ||
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
              openAIErrorResponse.response.data.error.message
                .includes('That model is currently overloaded with other requests.'));
          this.log[highlightRequestTimingLogic ? 'warn' : 'debug']({
            openAIResponseMessage: openAIErrorResponse.response.data.error.message
          });
        }

        if (rateLimitReached) {
          this.batches.push(batchForRequest);
        }

        return {
          tokensUsed,
          rateLimitReached
        };
      }
    };
  }
}

const createOpenAIBatchProcessor = _.once(
  (log: NTHLogger, completionParams: CreateCompletionRequest) => new OpenAIBatchProcessor(log, completionParams)
);

const getCompletionRequestParams = _.once((codemod: AICodemod, codemodOpts: CodemodArgsWithSource) =>
  codemod.getGlobalCompletionRequestParams
    ? codemod.getGlobalCompletionRequestParams(_.omit(codemodOpts))
    : defaultCompletionRequestParams);

export default async function runAICodemod(codemod: AICodemod, codemodOpts: CodemodArgsWithSource, log: NTHLogger) {
  let completionParams: CreateCompletionRequest;
  try {
    completionParams = await getCompletionRequestParams(codemod, codemodOpts);
  } catch (e: unknown) {
    throw makePhaseError(
      e as Error,
      'codemod.getCompletionRequestParams()',
      "Check your getCompletionRequestParams() method for a bug, or add this file to your codemod's ignore list."
    );
  }
  const openAIBatchProcessor = createOpenAIBatchProcessor(log, completionParams);

  let prompt: string;
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
