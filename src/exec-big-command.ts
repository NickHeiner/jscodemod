import execa from 'execa';
import _ from 'lodash';
import noOpLogger from './no-op-logger';

const getShellArgMax = _.once(async () => parseInt((await execa('getconf', ['ARG_MAX'])).stdout));

function execBigCommand(
  constantArgs: string[],
  variableArgs: string[],
  execCommand: (args: string[]) => Promise<execa.ExecaReturnValue>,
  {
    log = noOpLogger,
    maxArgCount = Infinity,
  }: {
    log?: typeof noOpLogger;
    maxArgCount?: number;
  } = {}
): Promise<void> {
  async function execBigCommandRec(variableArgs: string[]) {
    const combinedArgs = [...constantArgs, ...variableArgs];
    const commandLengthBytes = new TextEncoder().encode(combinedArgs.join(' ')).length;
    const shellArgMaxBytes = await getShellArgMax();

    /**
     * My understanding is that if the commandLengthBytes < shellArgMaxBytes, then we should be safe. However,
     * experimentally, this was not true. I still saw E2BIG errors. I don't know if it's because I'm misinterpreting
     * what results of TextEncoder and `ARG_MAX`. But, if I divide by 2, then it worked in my anecdotal testing.
     */
    if (variableArgs.length > maxArgCount || commandLengthBytes > shellArgMaxBytes / 2) {
      log.debug(
        {
          variableArgCount: variableArgs.length,
          maxArgCount,
          variableArgLengthBytes: commandLengthBytes,
          shellArgMaxBytes,
        },
        'Splitting command to avoid an E2BIG error.'
      );
      const midpointIndex = variableArgs.length / 2;
      const firstHalfVariableArgs = variableArgs.slice(0, midpointIndex);
      const secondHalfVariableArgs = variableArgs.slice(midpointIndex);

      // It's probably safer to run in serial here. The caller may not expect their command to be parallelized.
      await execBigCommandRec(firstHalfVariableArgs);
      await execBigCommandRec(secondHalfVariableArgs);
    } else {
      await execCommand(combinedArgs);
    }
  }

  return execBigCommandRec(variableArgs);
}
export default execBigCommand;
