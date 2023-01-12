import {OpenAIAPIRateLimiter} from '../src/run-ai-codemod';
import createLog from 'nth-log';

const log = createLog({name: 'test'});

jest.useFakeTimers();
describe('OpenAIAPIRateLimiter', () => {
  it('limits the request rate', () => {
    const makeRequest = jest.fn(() => Promise.resolve({
      tokensUsed: 5,
      rateLimitReached: false
    }));
    let estimatedTokens = 6;
    const getNextRequest = () => ({makeRequest, estimatedTokens});
    const tokenRateLimit = 20;
    const rateLimiter = new OpenAIAPIRateLimiter(log, 3, tokenRateLimit, getNextRequest);
    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();
    expect(makeRequest).toHaveBeenCalledTimes(1);
    makeRequest.mockClear();

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

    expect(makeRequest).toHaveBeenCalledTimes(3);
    makeRequest.mockClear();

    jest.advanceTimersToNextTimer(Infinity);

    expect(makeRequest).toHaveBeenCalledTimes(1);
    makeRequest.mockClear();

    jest.advanceTimersByTime(60_000);
    estimatedTokens = tokenRateLimit + 1;

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer(Infinity);

    rateLimiter.attemptCall();
    jest.advanceTimersToNextTimer();

    expect(makeRequest).toHaveBeenCalledTimes(1);
  });
});