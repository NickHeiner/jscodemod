export default function buildFullPrompt(prompt: string, sourceCode: string): string {
  const promptWithInputSubstitued = prompt.replaceAll('{{INPUT_SOURCE_CODE}}', sourceCode);
  const wrappedPrompt = prompt.includes('\n')
    ? `/*\n${promptWithInputSubstitued}\n*/\n` : `${sourceCode}\n\n/*${prompt}*/`;
  return `${wrappedPrompt}\n`;
}