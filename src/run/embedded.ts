// The library as the compiled binary carries it: evaluated at bundle time by
// the ./bundle.ts macro. Only imported when this process is the compiled
// executable, so running from source never bundles anything.

import {library} from './bundle.ts' with {type: 'macro'}

export const LIBRARY: string = library()
