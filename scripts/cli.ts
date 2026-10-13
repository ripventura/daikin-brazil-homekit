// Live check against a unit, without Homebridge:
//   DAIKIN_KEY=<base64> npm run cli -- <ip> get|status|set '<json>'
import { DaikinClient } from '../src/client.js';

const [ip, cmd, json] = process.argv.slice(2);
const key = process.env.DAIKIN_KEY;
if (!ip || !cmd || !key) {
  console.error("usage: DAIKIN_KEY=<base64> npm run cli -- <ip> get|status|set '<json>'");
  process.exit(2);
}
const client = new DaikinClient(ip, key);
const result =
  cmd === 'status' ? await client.getStatus()
    : cmd === 'set' ? await client.setState(JSON.parse(json ?? '{}'))
      : await client.getState();
console.log(JSON.stringify(result, null, 2));
