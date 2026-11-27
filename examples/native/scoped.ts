// Both commands share one budget, concurrently; neither restarts its clock.
// The budget is not a separate OS cancellation group.
import {Scope, receipt} from 'jev-fabric'

const scope = Scope.open()
const [first, second] = await Promise.all([scope.exec(['/bin/echo', 'first']), scope.exec(['/bin/echo', 'second'])])
console.log(receipt(first))
console.log(receipt(second))
