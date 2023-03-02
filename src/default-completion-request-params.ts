import {CreateCompletionRequest, CreateChatCompletionRequest} from 'openai';

export const defaultCompletionParams: CreateCompletionRequest = {
  model: 'text-davinci-003',
  temperature: 0
};

export const defaultChatParams: CreateChatCompletionRequest = {
  model: 'gpt-3.5-turbo',
  temperature: 0,
  messages: [
    {
      role: 'system',
      content: 'You are a helpful assistant and expert coder.'
    }
  ]
};
