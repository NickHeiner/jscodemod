import {NTHLogger} from 'nth-log';
import {makePhaseError} from './make-phase-error';
import {AICodemod, CodemodArgsWithSource, CodemodResult} from './types';
import {Configuration, OpenAIApi, CreateCompletionResponse, CreateCompletionRequest} from 'openai';

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
    )
  }
  return completion;
}

function getCodemodTransformResult(
  codemod: AICodemod,
  prompt: CreateCompletionRequest['prompt'],
  response: CreateCompletionResponse
): CodemodResult<unknown> {
  if (codemod.extractTransformationFromCompletion) {
    return codemod.extractTransformationFromCompletion(response);
  }
  if (typeof prompt === 'string') {
    return defaultExtractResultFromCompletion(response.choices[0].text);
  }
  throw makePhaseError(
    new Error(
      // eslint-disable-next-line max-len
      `The fallback extractTransformationFromCompletion implementation only works when the prompt is a string, but your prompt is of type "${typeof prompt}"`
    ),
    'extracting the transformed code from the completion',
    'Implement your own extractTransformationFromCompletion method'
  );
}

export default async function runAICodemod(codemod: AICodemod, codemodOpts: CodemodArgsWithSource, log: NTHLogger) {
  const apiKey = getAPIKey();

  let completionRequestParams: CreateCompletionRequest;
  try {
    completionRequestParams = await codemod.getCompletionRequestParams(codemodOpts);
  } catch (e: unknown) {
    throw makePhaseError(
      e as Error,
      'codemod.getCompletionRequestParams()',
      "Check your getCompletionRequestParams() method for a bug, or add this file to your codemod's ignore list."
    );
  }

  const configuration = new Configuration({
    organization: 'org-Gxi40GyAs8FnliemJe5YJJaK',
    apiKey
  });
  const openai = new OpenAIApi(configuration);
  const axiosResponse = await log.logPhase(
    {phase: 'OpenAI request', level: 'debug'},
    async (_, setAdditionalLogData) => {
      const response = await openai.createCompletion(completionRequestParams);
      // @ts-expect-error This is fine, but the types are too restrictive.
      setAdditionalLogData(response.data);
      return response;
    }
  );

  return getCodemodTransformResult(codemod, completionRequestParams.prompt, axiosResponse.data);
}
