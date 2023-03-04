// We need to use a polyfill because replaceAll only started being available in Node 15.
// I'm not sure what the right way to import this is according to TS, but this works.
// @ts-expect-error
import replaceAll from 'core-js/es/string/replace-all';

export default function buildFullPrompt(prompt: string, sourceCode: string): string {
  const promptWithInputSubstitued = replaceAll(prompt, '{{INPUT_SOURCE_CODE}}', sourceCode);
  const wrappedPrompt = prompt.includes('\n')
    ? `/* ${promptWithInputSubstitued} */\n`
    : `${sourceCode}\n\n/*${prompt}*/`;

  // Add a trailing newline, since sometimes the model returns empty results otherwise.
  return `${wrappedPrompt}\n`;
}
