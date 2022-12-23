import {NTHLogger} from 'nth-log';
import {makePhaseError} from './make-phase-error';
import {AICodemod, CodemodArgsWithSource, CodemodResult, AIPrompt} from './types';
import {Configuration, OpenAIApi, CreateCompletionResponse, CreateCompletionRequest} from 'openai';
import _ from 'lodash';
import defaultCompletionRequestParams from './default-completion-request-params';
import pDebounce from 'p-debounce';
import pThrottle from 'p-throttle';
import {EventEmitter} from 'events';

function getAPIKey() {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  throw new Error(
    'Env var `OPENAI_API_KEY` was not set. You must set it to your API key if you want to use an AI codemod.'
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

class OpenAIBatchProcessor {
  private openai: OpenAIApi;
  private completionParams: CreateCompletionRequest;
  private prompts: AIPrompt[] = [];
  private log: NTHLogger;
  private promptEventEmitter = new EventEmitter();

  private openAIAPIRateLimitRequestsPerMinute = 20;
  private secondsPerMinute = 60;
  private openAIAPIRateLimitReciprocal = this.secondsPerMinute / this.openAIAPIRateLimitRequestsPerMinute;

  private rateLimitedSendBatch: () => any;

  constructor(log: NTHLogger, completionParams: CreateCompletionRequest) {
    const apiKey = getAPIKey();
    this.log = log;
    this.completionParams = completionParams;

    const configuration = new Configuration({
      // TODO: make this configurable
      organization: 'org-Gxi40GyAs8FnliemJe5YJJaK',
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

  complete(prompt: AIPrompt): Promise<CreateCompletionResponse> {
    this.log.trace({prompt}, 'Adding prompt to batch');
    this.prompts.push(prompt);
    this.rateLimitedSendBatch();
    return new Promise(resolve => {
      this.promptEventEmitter.once(prompt, resolve);
    });
  }

  private async sendBatch() {
    if (!this.completionParams) {
      throw new Error('Internal error: Completion params not set');
    }
    const promptsForRequest = [...this.prompts];
    this.prompts = [];
    const completionRequestParams = {
      ...this.completionParams,
      prompt: promptsForRequest
    };
    const axiosResponse = await this.log.logPhase(
      {phase: 'OpenAI request', level: 'debug', completionRequestParams},
      async (_, setAdditionalLogData) => {
        const response = await this.openai.createCompletion(completionRequestParams);
        setAdditionalLogData({completionResponse: response.data});
        return response;
      }
    );

    promptsForRequest.forEach((prompt, index) => {
      const completion = axiosResponse.data.choices[index];
      const completionWithOnlyThisChoice = {
        ...axiosResponse.data,
        choices: [completion]
      };
      this.log.trace({completion, prompt});
      this.promptEventEmitter.emit(prompt, completionWithOnlyThisChoice);
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
