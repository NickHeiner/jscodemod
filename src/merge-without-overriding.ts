import _ from 'lodash';
import CodeError from './code-error';

export class MergeError extends CodeError {
  overlappingKeys: string[];

  constructor(message: string, code: string, overlappingKeys: string[]) {
    super(message, code);
    this.overlappingKeys = overlappingKeys;
  }
}

export default function mergeWithoutOverriding<
  T extends undefined | null | Record<string, unknown>,
  E extends Record<string, unknown>
>(source1: T, source2: E): T extends undefined | null ? E : T & E {
  if (!source1) {
    // @ts-expect-error
    return source2;
  }

  if (!source2) {
    // @ts-expect-error
    return source1;
  }

  // @ts-expect-error
  const overlappingKeys = _.intersection(Object.keys(source1), Object.keys(source2));
  if (overlappingKeys.length) {
    throw new MergeError(
      // eslint-disable-next-line max-len
      `Merge source objects can only have non-overlapping properties, but the following properties were defined in both: ${overlappingKeys}`,
      'ARGUMENT_ERROR',
      overlappingKeys
    );
  }

  // @ts-expect-error
  return {...source1, ...source2};
}