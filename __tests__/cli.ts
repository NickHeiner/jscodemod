import { validateAndGetRequestParams } from '../src/cli';
import { CreateChatCompletionRequest } from 'openai';

afterEach(() => {
  jest.clearAllMocks();
});

test('no params are passed', () => {
  expect(
    validateAndGetRequestParams({
      openAICompletionRequestConfig: undefined,
      openAICompletionRequestFile: undefined,
      completionPromptFile: undefined,
      chatMessageFile: undefined,
      completionPrompt: undefined,
      chatMessage: undefined,
      openAIChatRequestConfig: undefined,
      openAIChatRequestFile: undefined,
    })
  ).toBeUndefined();
});

test('chat message', () => {
  expect(
    validateAndGetRequestParams({
      openAICompletionRequestConfig: undefined,
      openAICompletionRequestFile: undefined,
      completionPromptFile: undefined,
      chatMessageFile: undefined,
      completionPrompt: undefined,
      chatMessage: 'my chat message',
      openAIChatRequestConfig: undefined,
      openAIChatRequestFile: undefined,
    })
  ).toMatchInlineSnapshot(`
    {
      "messages": [
        {
          "content": "my chat message",
          "role": "user",
        },
      ],
      "model": "gpt-3.5-turbo",
      "temperature": 0,
    }
  `);
});

describe('error handling', () => {
  describe('completion', () => {
    test('prompt is passed in both toplevel flag and config', () => {
      expect(() =>
        validateAndGetRequestParams({
          openAICompletionRequestConfig: JSON.stringify({
            prompt: 'prompt dupe',
          }),
          openAICompletionRequestFile: undefined,
          completionPromptFile: undefined,
          chatMessageFile: undefined,
          completionPrompt: 'prompt',
          chatMessage: undefined,
          openAIChatRequestConfig: undefined,
          openAIChatRequestFile: undefined,
        })
      ).toThrow(
        // eslint-disable-next-line max-len
        'If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags.'
      );
    });
    test('default params are used', () => {
      expect(
        validateAndGetRequestParams({
          openAICompletionRequestConfig: undefined,
          openAICompletionRequestFile: undefined,
          completionPromptFile: undefined,
          chatMessageFile: undefined,
          completionPrompt: 'my prompt',
          chatMessage: undefined,
          openAIChatRequestConfig: undefined,
          openAIChatRequestFile: undefined,
        })
      ).toMatchInlineSnapshot(`
      {
        "model": "text-davinci-002",
        "prompt": "my prompt",
        "temperature": 0,
      }
      `);
    });
  });
  describe('chat', () => {
    test('prompt is passed in both toplevel flag and config', () => {
      expect(() =>
        validateAndGetRequestParams({
          openAICompletionRequestConfig: undefined,
          openAICompletionRequestFile: undefined,
          completionPromptFile: undefined,
          chatMessageFile: undefined,
          completionPrompt: undefined,
          chatMessage: 'message',
          openAIChatRequestConfig: JSON.stringify({
            messages: [{ role: 'user', content: 'message dupe' }],
            model: 'my-model',
          } satisfies CreateChatCompletionRequest),
          openAIChatRequestFile: undefined,
        })
      ).toThrow(
        // eslint-disable-next-line max-len
        'If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags.'
      );
    });
    test('default params are used', () => {
      expect(
        validateAndGetRequestParams({
          openAICompletionRequestConfig: undefined,
          openAICompletionRequestFile: undefined,
          completionPromptFile: undefined,
          chatMessageFile: undefined,
          completionPrompt: undefined,
          chatMessage: 'my message',
          openAIChatRequestConfig: undefined,
          openAIChatRequestFile: undefined,
        })
      ).toMatchInlineSnapshot(`
      {
        "messages": [
          {
            "content": "my message",
            "role": "user",
          },
        ],
        "model": "gpt-3.5-turbo",
        "temperature": 0,
      }
      `);
    });
  });
});
