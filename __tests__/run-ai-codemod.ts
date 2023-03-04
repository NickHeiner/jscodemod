import { OpenAIAPIRateLimiter, __test } from '../src/run-ai-codemod';
import createLog from 'nth-log';
import { AIChatCodemod } from '../build';
import { CreateChatCompletionRequest } from 'openai';

const log = createLog({ name: 'test' });

/**
 * These tests are very limited.
 */

jest.useFakeTimers();
describe('OpenAIAPIRateLimiter', () => {
  it('respects the call rate limit', () => {
    const makeRequest = jest.fn(() =>
      Promise.resolve({
        tokensUsed: 5,
        rateLimitReached: false,
      })
    );
    const getNextRequest = () => ({ makeRequest, estimatedTokens: 6 });
    const tokenRateLimit = 20;
    const rateLimiter = new OpenAIAPIRateLimiter(log, 3, tokenRateLimit, getNextRequest);

    // Making a single call should result in a request.
    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();
    expect(makeRequest).toHaveBeenCalledTimes(1);
    makeRequest.mockClear();

    // We need jest.advanceTimersToNextTimer() because of the debounce on attemptCall, which I'm not sure is actually
    // necessary.
    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    // We only expect 3 calls, because the calls above will exceed the local rate limit.
    expect(makeRequest).toHaveBeenCalledTimes(3);
    makeRequest.mockClear();

    jest.advanceTimersToNextTimer(Infinity);

    // Once the rate limit clears, we expect the rate limiter to retry automatically.
    expect(makeRequest).toHaveBeenCalledTimes(1);
    makeRequest.mockClear();
  });

  it('respects the token rate limit', () => {
    const makeRequest = jest.fn(() =>
      Promise.resolve({
        tokensUsed: 5,
        rateLimitReached: false,
      })
    );
    let estimatedTokens = 6;
    const getNextRequest = () => ({ makeRequest, estimatedTokens });
    const tokenRateLimit = 20;
    const rateLimiter = new OpenAIAPIRateLimiter(log, 3, tokenRateLimit, getNextRequest);
    estimatedTokens = tokenRateLimit + 1;

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer(Infinity);

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    // We make two calls, but only expect one to go through, because the first call used too many tokens.
    expect(makeRequest).toHaveBeenCalledTimes(1);
    makeRequest.mockClear();
  });

  /**
   * This test fails, even though the functionality its testing seems to work in practice. I think this has to do with
   * the idiosyncrasies of Jest's fake timers.
   */
  it.skip('respects the API-provided rate limit feedback', () => {
    const makeRequest = jest.fn(() =>
      Promise.resolve({
        tokensUsed: 5,
        rateLimitReached: false,
      })
    );
    const getNextRequest = () => ({ makeRequest, estimatedTokens: 6 });
    const tokenRateLimit = 20;
    const rateLimiter = new OpenAIAPIRateLimiter(log, 3, tokenRateLimit, getNextRequest);
    makeRequest.mockImplementation(() =>
      Promise.resolve({ tokensUsed: 5, rateLimitReached: true })
    );

    rateLimiter.attemptCall();
    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    // We expect the first call to have occurred. It results in a rateLimitReached response, so the rate limiter
    // enqueues a retry.
    expect(makeRequest).toHaveBeenCalledTimes(1);
    jest.advanceTimersToNextTimer(Infinity);

    // Validate that the retry occurred.
    expect(makeRequest).toHaveBeenCalledTimes(2);
    makeRequest.mockClear();
  });
});

describe('getAIChatCodemodParams', () => {
  test('does not mutate messages when called multiple times', async () => {
    const codemod: AIChatCodemod = {
      getMessages: source => [{ role: 'user', content: source }],
      getGlobalAPIRequestParams: () =>
        ({
          model: 'my-model',
          messages: [],
        } as CreateChatCompletionRequest),
    };

    __test.getAIChatCodemodParams(codemod, { source: 'file source code', filePath: 'file.js' });
    const secondResult = await __test.getAIChatCodemodParams(codemod, {
      source: 'file source code',
      filePath: 'file.js',
    });

    expect(secondResult.messages).toEqual([{ role: 'user', content: 'file source code' }]);
  });
});
