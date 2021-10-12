import mergeWithoutOverriding from '../src/merge-without-overriding';

describe('mergeWithoutOverriding', () => {
  it('merges', () => {
    expect(mergeWithoutOverriding({a: 1}, {b: 2})).toEqual({a: 1, b: 2});
  });

  it('merges with undefined', () => {
    expect(mergeWithoutOverriding(undefined, {b: 2})).toEqual({b: 2});
  });

  it('throws an error for overlapping properties', () => {
    expect(() =>
      mergeWithoutOverriding({a: 1, overlap: 2}, {b: 3, overlap: 4})
    ).toThrowErrorMatchingInlineSnapshot(
    // eslint-disable-next-line max-len
      '"Merge source objects can only have non-overlapping properties, but the following properties were defined in both: overlap"'
    );
  });
});