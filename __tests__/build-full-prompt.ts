import buildFullPrompt from '../src/build-full-prompt';

it('handles multiline inputs', () => {
  expect(
    buildFullPrompt(
      `
    My prompt

    {{INPUT_SOURCE_CODE}}

    More text

    {{INPUT_SOURCE_CODE}}
  `,
      'source_code'
    )
  ).toMatchInlineSnapshot(`
"/* 
    My prompt

    source_code

    More text

    source_code
   */

"
`);
});

it('handles single line inputs', () => {
  expect(buildFullPrompt('my prompt', 'source_code')).toMatchInlineSnapshot(`
"source_code

/*my prompt*/
"
`);
});
