import {validateAndGetRequestParams} from '../src/cli';
import fs from 'fs';
import { CreateChatCompletionRequest } from 'openai';
import * as loadJsonFile from 'load-json-file';

afterEach(() => {
  jest.clearAllMocks();
})

test('no params are passed', () => {
  expect(validateAndGetRequestParams({
    openAICompletionRequestConfig: undefined,
    openAICompletionRequestFile: undefined,
    completionPromptFile: undefined,
    chatMessageFile: undefined,
    completionPrompt: undefined,
    chatMessage: undefined,
    openAIChatRequestConfig: undefined,
    openAIChatRequestFile: undefined
  })).toBeNull();
});

describe('error handling', () => {
  describe('completion', () => {
    test('prompt is passed in both toplevel flag and config', () => {
      expect(() => validateAndGetRequestParams({
        openAICompletionRequestConfig: JSON.stringify({
          prompt: 'prompt dupe'
        }),
        openAICompletionRequestFile: undefined,
        completionPromptFile: undefined,
        chatMessageFile: undefined,
        completionPrompt: 'prompt',
        chatMessage: undefined,
        openAIChatRequestConfig: undefined,
        openAIChatRequestFile: undefined
      })).toThrow('If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags.');
    });
    test('prompt is passed in both file and config', () => {
      jest.spyOn(fs, 'readFileSync').mockImplementation((path, ...rest) => {
        if (path === 'prompt.txt') {
          return 'prompt dupe';
        }
        return fs.readFileSync(path, ...rest);
      });

      expect(() => validateAndGetRequestParams({
        openAICompletionRequestConfig: JSON.stringify({
          prompt: 'prompt dupe'
        }),
        openAICompletionRequestFile: undefined,
        completionPromptFile: 'prompt.txt',
        chatMessageFile: undefined,
        completionPrompt: undefined,
        chatMessage: undefined,
        openAIChatRequestConfig: undefined,
        openAIChatRequestFile: undefined
      })).toThrow('If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags.');
    });
  });
  describe('chat', () => {
    test('prompt is passed in both toplevel flag and config', () => {
      expect(() => validateAndGetRequestParams({
        openAICompletionRequestConfig: undefined,
        openAICompletionRequestFile: undefined,
        completionPromptFile: undefined,
        chatMessageFile: undefined,
        completionPrompt: undefined,
        chatMessage: 'message',
        openAIChatRequestConfig: JSON.stringify({
          message: 'message dupe'
        }),
        openAIChatRequestFile: undefined
      })).toThrow('If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags.');
    });
    test.only('prompt is passed in both file and config', () => {
      const originalReadFileSync = fs.readFileSync;
      jest.spyOn(fs, 'readFileSync').mockImplementation((path, ...rest) => {
        if (path === 'message.txt') {
          return 'message dupe';
        }
        return originalReadFileSync(path, ...rest);
      });

      const originalLoadJsonFileSync = loadJsonFile.sync;
      jest.spyOn(loadJsonFile, 'sync').mockImplementation(filePath => {
        console.log(filePath);
        if (filePath === 'chat-config.json') {
          return {
            messages: [{role: 'user', content: 'message'}],
            model: 'my-model'
          } as CreateChatCompletionRequest;
        }
        return originalLoadJsonFileSync(filePath);
      })

      expect(() => validateAndGetRequestParams({
        openAICompletionRequestConfig: undefined,
        openAICompletionRequestFile: undefined,
        completionPromptFile: undefined,
        chatMessageFile: 'message.txt',
        completionPrompt: undefined,
        chatMessage: undefined,
        openAIChatRequestConfig: undefined,
        openAIChatRequestFile: 'chat-config.json'
      })).toThrow('If your API params include a prompt or message, you must not pass a separate prompt or message via the other command line flags.');
    });
  });
});
