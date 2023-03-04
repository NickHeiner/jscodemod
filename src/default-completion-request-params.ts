import {CreateCompletionRequest, CreateChatCompletionRequest} from 'openai';

export const defaultCompletionParams: Omit<CreateCompletionRequest, 'prompt'> = {
  model: 'text-davinci-003',
  temperature: 0
};

export const defaultChatParams: Omit<CreateChatCompletionRequest, 'messages'> = {
  model: 'gpt-3.5-turbo',
  temperature: 0
};
