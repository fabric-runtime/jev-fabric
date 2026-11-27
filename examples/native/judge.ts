// Opt-in: sends only synthetic text, one billed Jev call. Credentials resolve
// privately from the provider key or JEV_CREDENTIAL_COMMAND.
import {Jev} from 'jev-fabric'

const jev = Jev.connect({maxEvaluations: 1, maxTokens: 10000})
const answer = await jev.evaluate({
  state: 'Synthetic build: 12 tests passed.',
  questions: {healthy: {type: 'noul', instructions: 'Do the observed tests appear healthy?'}},
})
console.log(answer.json)
