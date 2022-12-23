import {CreateCompletionRequest} from 'openai';

export default {
  model: 'code-davinci-002',

  // If you set this value too high, you'll get status code 429.
  // eslint-disable-next-line camelcase
  max_tokens: 300,

  temperature: 0
} satisfies CreateCompletionRequest;