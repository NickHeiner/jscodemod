import {NTHLogger} from 'nth-log';
import {makePhaseError} from './make-phase-error';
import {AICodemod, CodemodArgsWithSource, CodemodResult, AIPrompt} from './types';
import {Configuration, OpenAIApi, CreateCompletionResponse, CreateCompletionRequest} from 'openai';
import _ from 'lodash';
import defaultCompletionRequestParams from './default-completion-request-params';
import pDebounce from 'p-debounce';
import pThrottle from 'p-throttle';
import {EventEmitter} from 'events';
// @ts-expect-error
import {countTokens} from '@nick.heiner/gpt-3-encoder/Encoder';

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
    data: {
      error: {
        message: string;
        type: string;
        param: any;
        code: any;
      }
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

  private readonly maxTokensPerRequest = 2048;
  private readonly tokenSafetyMargin = 1.1;

  private readonly openAIAPIRateLimitRequestsPerMinute = 20;
  private readonly secondsPerMinute = 60;
  private readonly openAIAPIRateLimitReciprocal = this.secondsPerMinute / this.openAIAPIRateLimitRequestsPerMinute;

  private rateLimitedSendBatch: () => any;

  constructor(log: NTHLogger, completionParams: CreateCompletionRequest) {
    const apiKey = getAPIKey();
    this.log = log;
    this.completionParams = completionParams;

    const configuration = new Configuration({
      organization: getOrganizationId(),
      apiKey
    });

    this.openai = new OpenAIApi(configuration);

    const debouncedSetBatch = pDebounce(this.sendBatch.bind(this), this.openAIAPIRateLimitReciprocal);
    const throttle = pThrottle({
      limit: this.openAIAPIRateLimitRequestsPerMinute,
      interval: this.secondsPerMinute * 1000,
      strict: true
    });
    this.rateLimitedSendBatch = throttle(debouncedSetBatch);
  }

  private getTokensForBatch(batch: AIPrompt[]) {
    const tokensInBatch = _.sumBy(batch, prompt => countTokens(prompt));
    return Math.ceil(tokensInBatch * this.tokenSafetyMargin);
  }

  private addPrompt(prompt: AIPrompt) {
    const log = this.log.child({prompt, method: 'OpenAIBatchProcessor#addPrompt'});
    log.trace('Adding prompt to batch');
    if (!this.batches.length) {
      log.trace('Creating new batch because there are no batches');
      this.batches.push([prompt]);
      return;
    }
    const newestBatch = _.last(this.batches)!;
    const tokensInNewestBatch = this.getTokensForBatch(newestBatch);
    const overheadRemainingInLastBatch = this.maxTokensPerRequest - (tokensInNewestBatch * 2);
    const tokensForLatestPrompt = countTokens(prompt);
    log.trace({tokensForLatestPrompt, overheadRemainingInLastBatch, tokensInNewestBatch});
    if (tokensForLatestPrompt > overheadRemainingInLastBatch) {
      log.trace('Creating new batch');
      this.batches.push([prompt]);
    } else {
      log.trace('Adding to existing batch');
      newestBatch.push(prompt);
    }
  }

  complete(prompt: AIPrompt): Promise<CreateCompletionResponse> {
    this.log.trace({prompt}, 'Adding prompt to batch');
    this.addPrompt(prompt);
    this.rateLimitedSendBatch();
    return new Promise((resolve, reject) => {
      this.successPerPromptEventEmitter.once(prompt, resolve);
      this.failurePerPromptEventEmitter.once(prompt, reject);
    });
  }

  private async sendBatch() {
    if (!this.completionParams) {
      throw new Error('Internal error: Completion params not set');
    }
    if (!this.batches.length) {
      return;
    }
    const batchForRequest = this.batches.shift()!;
    if (this.batches.length) {
      this.rateLimitedSendBatch();
    }
    const tokensInBatch = this.getTokensForBatch(batchForRequest);
    const completionRequestParams = {
      ...this.completionParams,
      prompt: batchForRequest,
      max_tokens: this.maxTokensPerRequest - tokensInBatch
    };
    const axiosResponse = await this.log.logPhase(
      {phase: 'OpenAI request', level: 'debug', completionRequestParams},
      async (_, setAdditionalLogData) => {
        try {
          const response = await this.openai.createCompletion(completionRequestParams);
          setAdditionalLogData({completionResponse: response.data});
          return response;
        } catch (e: unknown) {
          setAdditionalLogData({errorResponseData: (e as OpenAIErrorResponse).response.data, status: 'failed'});
          return e as OpenAIErrorResponse;
        }
      }
    );

    batchForRequest.forEach((prompt, index) => {
      if (axiosResponse instanceof Error) {
        if (axiosResponse.response?.status === 429) {
          this.failurePerPromptEventEmitter.emit(prompt);
          return;
        }
        throw axiosResponse;
      }

      const completion = axiosResponse.data.choices[index];
      const completionWithOnlyThisChoice = {
        ...axiosResponse.data,
        choices: [completion]
      };
      this.log.trace({completion, prompt});
      this.successPerPromptEventEmitter.emit(prompt, completionWithOnlyThisChoice);
    });
  }
}

const createOpenAIBatchProcessor = _.once(
  (log: NTHLogger, completionParams: CreateCompletionRequest) => new OpenAIBatchProcessor(log, completionParams)
);

const getCompletionRequestParams = _.once(async (codemod: AICodemod, codemodOpts: CodemodArgsWithSource) =>
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

  const result = await openAIBatchProcessor.complete(prompt);

  return getCodemodTransformResult(codemod, result);
}
