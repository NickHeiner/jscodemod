import fs from 'fs';
import createLog from 'nth-log';

export default createLog({ name: 'no-op', stream: fs.createWriteStream('/dev/null') });
