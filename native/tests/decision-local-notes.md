# Local chat classifier integration notes

## Public API

```bend
DecisionLocal.preflight(request: J.JSON)
  -> Result<&1, &1, U32 & String, Unit>
DecisionLocal.evaluate(request: J.JSON, provider: String, model: String,
  endpoint: String, key: String, timeout: U32, allow_local: Bool)
  -> IO(Result<&1, &1, U32 & String, J.JSON>)
```

`preflight` is pure: call it before credentials and evaluation reservation. It
validates the entire request/questions, local opt-in, no images, and positive
finite-double temperature using exact decimal halfway bounds (no F32 conversion).
It cannot determine single-token labels until `/tokenize` runs. The resolved model
argument is authoritative. Dedicated system-one classification is **not** routed
through this adapter.

Local limits: 1..64 questions; choices 2..62; score levels 2..10; boolean aliases
`boolean`, `bool`, `noul`, `predicate` all output canonical `type:"boolean"`.
Score probabilities and legend are objects keyed by "0".."n-1"; the legend
retains original structured criteria without numeric conversion.
Instructions and descriptions may be structured JSON and are losslessly encoded.
Temperature defaults to 1 and affects label softmax only; `/completion` always
requests one token at temperature 0 with `post_sampling_probs:false`.

Every label must resolve to a unique single token, preferring tokenization after
newline with a standalone fallback. All calls carry the resolved model. There is
one monotonic `IO.now` deadline across tokenization, templates and completions;
HTTP errors are never retried. Missing labels alone deepen `n_probs` from
`max(256,16*labels)` to 4096 and 32768. All labels must be present before softmax.

## Result and accounting

Successful `Done` envelopes have `provider`, `api:"llama-cpp"`, `model`, `status`,
`answers`, nullable `usage.input_tokens/output_tokens`, `provenance`, `raw`,
`rawJson`, and `rawComplete`. Prevalidation errors use `Fail`; execution failures
use `Done` with `status:"error"`, an empty answers object and `{code,message}`
error. Completed readouts and captured usage survive those failures.

Raw entries are chronological `{path,n_probs,body,text}`: `body` is the original
strict JSON AST (including unknown fields and numeric lexemes); `text` is the
original UTF-8 provider body including whitespace. `rawJson` is a strict,
lexeme-preserving serialization of the complete raw array. JS callers should
retain **the string**, since parsing it into JS numbers rounds native decimals.
Malformed JSON still retains its text. Invalid UTF-8 has no JSON AST: its entry's
body is `{encoding:"base64",data:...}` with empty text, retaining exact bytes.
Each entry includes `httpStatus`; bounded non-2xx bodies are captured before
returning an error. Incomplete transport failures still have no complete exchange.

`provenance.kind:"token-logprobs"`, `nativeProbabilities:false`, and
`method:"label-softmax"` explicitly distinguish derived double statistics from
native provider probabilities. Each answer also records label/key/token-ID/raw
logprob mapping and temperature. The raw readouts are never rounded by the math
helper. Native logprobs are not generated model answers.

Usage is summed only from captured `tokens_evaluated` and `tokens_predicted`
across **every** successful completion, including deeper readouts. Missing,
invalid, overflowed or interrupted/pending completion usage is null, not an
invented zero. A no-completion evaluation also reports null. The native session driver owns session
budgets and conservatively closes the remaining budget on unknown usage.

Each response and the output profile is capped at 16 MiB / 524288 work. Raw
capture additionally charges **both** AST and escaped rawJson representations
against 8 MiB and 400000 work, leaving envelope/answer room. Reaching the capture
bound stops with an explicit error naming the unretained current response; prior
captures and parsed usage survive. No successful truncation. `rawComplete:false`
on errors conservatively signals incomplete evaluation capture. These are
operational size bounds, not a claim of preemptible pure CPU work.

## Trusted boundary

Bend 2.0.38 has F32, not F64. `native/DecisionMath.bend` declares
`Native.statistics(temperature:String,values:String)` in
`native/decision_math.c`. This is an additional **trusted foreign** declaration,
not a proof. It only parses bounded decimal inputs and computes finite double
statistics with stable subtract-before-divide softmax and `%.17g` roundtrips.
There are no subprocesses, shell commands, filesystem, environment, network or
clock operations. Locale handling is local; non-dot output locales fail closed.
It is native-only (no JS FFI implementation), and its ABI follows Bend 2.0.38.

`native/trust.json` classifies DecisionLocal/DecisionMath as effect drivers and
allowlists `DecisionMath.bend:Native.statistics -> native/decision_math.c`.
The safety audit checks that boundary; generic Codec limits remain unchanged.
Transport requires curl >=7.82 for repeated private `json=` chunks.

## Tests

`bun test native/tests/decision-local.test.ts` compiles the fixture directly with
Bend, installs `decision-local-curl.ts` as a private PATH fake, and opens no live
model/network connections. Coverage includes aliases, structured instructions,
62 labels, preflight-before-effects, exact temperature boundaries, stable math,
token fallback/collisions, full 32768-entry readout, missing/duplicate/nonfinite
logprobs, exact raw AST/text/rawJson retention, nullable/partial/overflow usage,
invalid UTF-8, aggregate capture limits, and the single shared deadline.
