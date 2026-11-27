// A literal argv, one owned process group, one bounded receipt.
// jev-fabric -- run examples/native/pipeline.ts
import {exec, receipt} from 'jev-fabric'

const result = await exec(['/bin/sh', '-c', "cat <<'TEXT' | tr a-z A-Z\nhello jev-fabric\nTEXT"])
console.log(receipt(result))
