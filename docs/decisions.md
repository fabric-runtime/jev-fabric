# Lossless decisions

`decide` is additive: it does not change `jev`, its strict choice/noul/score
answers, required distributions or required usage counters. It supports multiple
wire protocols, keeps the original provider response, and distinguishes native
decisions from generated estimates and local token-logprob readouts. Only make
model calls with authorization; validation and preset discovery are offline.

## CLI and clients

```sh
jev-fabric -- decision-providers                       # registered presets, offline
jev-fabric -- validate-decision request.json            # request schema, offline
jev-fabric -- decide --timeout-ms 30000 request.json 10000 # one evaluation
```

`max-tokens` defaults to 100000; the default timeout is
`JEV_FABRIC_JEV_TIMEOUT_MS`, else 30 seconds. A token cap bounds **reported**
usage, not the provider's bill or generated output length.

The [`serve` protocol](serve-protocol.md) advertises feature `decisions`:

| JSONL operation | Fields beyond `id` and `op` | TypeScript `Fabric` | Python `Fabric` |
| --- | --- | --- | --- |
| `decide` | `request`, `timeoutMs?`, `credential?` | `decide(request, { timeoutMs?, credential? })` | `decide(request, timeout_ms=…, credential=…)` |
| `validateDecision` | `request` | `validateDecision(request)` | `validate_decision(request)` |
| `decisionProviders` | none | `decisionProviders()` | `decision_providers()` |
| `resolveDecision` | `request` | `resolveDecision(request)` | `resolve_decision(request)` |

Feature `decision-targets` adds full offline resolution, profiles and bound
client views. See [decision targets](decision-targets.md) for the portable profile
format, model-selection flags and immutable handles sharing one session budget.

Unlike legacy `jev`, routing belongs **inside `request`**, not alongside it.
Validation returns the request after structural validation; it does not resolve
credentials, prove model availability, or exercise the provider-specific body
builder. Routing, opt-ins and adapter-specific constraints are checked before
model dispatch.

```ts
import { Fabric, type DecisionRequest } from './jev-fabric.ts';

const request: DecisionRequest = {
  provider: 'typesafe',
  state: { exitCode: 0, tests: 'passed' },
  questions: { healthy: { type: 'boolean', instructions: 'Are the tests healthy?' } },
};
const fabric = await Fabric.open({ maxEvaluations: 1, maxTokens: 10000 });
try {
  await fabric.validateDecision(request);
  // Explicit authorized model call; transport/preflight failures reject.
  const result = await fabric.decide(request, { timeoutMs: 30000 });
  if (result.status === 'error') throw new Error(result.error?.message);
  console.log(result.answers, result.budget);
} finally {
  await fabric.close();
}
```

## Request

```json
{
  "provider": "typesafe",
  "state": {"tests": "passed", "warnings": ["slow startup"]},
  "questions": {
    "healthy": {"type": "boolean", "instructions": "Is the service healthy?"},
    "next": {
      "type": "choice",
      "instructions": {"task": "Choose the next step"},
      "criteria": {"verify": "Check the deployment", "repair": {"when": "Broken tests"}}
    },
    "risk": {"type": "score", "instructions": "Assess risk", "criteria": ["Low", "High"]}
  }
}
```

- `state` and `instructions` accept the legacy structured descriptors: strings,
  arrays or objects, not scalar numbers/booleans/null. Nested JSON is retained;
  text-only wire slots receive JSON serialization, not string coercion.
- There are 1..128 questions with nonempty, printable IDs of at most 128 Unicode
  scalars. `choice.criteria` has 1..255 named options; descriptions may also be
  null. `score.criteria` has 2..10 described levels; scores may be fractional,
  from zero through the last index. Boolean aliases are `boolean`, `bool`,
  `noul`, `predicate`; optional criteria describe `true` and/or `false`.
- Optional fields: `images`, `profile`, `provider`, `api`, `model`, `endpoint`, `allowLocal`,
  `allowGenerated`, `providerOptions`, `temperature`. Unknown request/question
  fields and duplicate JSON keys are rejected.
- Adapter caps can be narrower: Cloudflare Clef/Flash accepts at most 64
  questions, IDs matching `[A-Za-z0-9_.-]` (1..100 characters), and choices with
  at least two options. Anthropic accepts 16 questions because each consumes an
  answer/refusal union; Google accepts 128. Local chat readouts accept 64
  questions and 2..62 choice options. These are implementation limits, not a
  promise of every vendor's full schema.

## Registered presets and routing

Discovery lists **registered preset definitions**, not live service models,
credential availability or verified account access. Defaults below come from
[`DecisionConfig.bend`](../native/DecisionConfig.bend); a model name is not proof
that it exists or is enabled on your account. Discovery returns an array of 14
objects with `provider`, `api`, `defaultModel`, `endpoint`, `credentialEnv`,
`imageSupport` (`supported`, `unsupported`, `model-dependent`) and `generated`.
`custom` has empty defaults; Cloudflare's endpoint contains an account placeholder.
Image support describes the adapter, not every model behind it.

| `provider` | `api` | Default model | Default endpoint | Key variable |
| --- | --- | --- | --- | --- |
| `typesafe` | `system-one` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` |
| `subq` | `system-one` | `subq-snap-preview` | `https://api.subq.ai/v1/systemone` | `SUBQ_API_KEY` |
| `openrouter` | `system-one` | `typesafe/jev-1.13` | `https://openrouter.ai/api/v1/systemone` | `OPENROUTER_API_KEY` |
| `vercel` | `system-one` | `typesafe-ai/jev` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `AI_GATEWAY_API_KEY` |
| `vercel-evaluate` | `vercel-evaluate` | `typesafe-ai/jev` | `https://ai-gateway.vercel.sh/v1/evaluate` | `AI_GATEWAY_API_KEY` |
| `vercel-decisions` | `openai-decisions` | `openai/gpt-6-luna-decisions` | `https://ai-gateway.vercel.sh/v1/decisions` | `AI_GATEWAY_API_KEY` |
| `openai` | `openai-decisions` | `gpt-6-luna` | `https://api.openai.com/v1/decisions` | `OPENAI_API_KEY` |
| `cloudflare-workers-ai` | `cloudflare` | `typesafe/jev` | `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run` | `CLOUDFLARE_API_TOKEN`, fallback `CLOUDFLARE_API_KEY` |
| `opencode` | `system-one` | `jev-1.13` | `https://opencode.ai/zen/v1/systemone` | `OPENCODE_API_KEY` |
| `llama.cpp` | `llama-cpp` | `local` | `http://127.0.0.1:8080` (server root) | `LLAMA_API_KEY` |
| `llama-system-one` | `llama-system-one` | `local` | `http://127.0.0.1:8080/v1/systemone` | `LLAMA_API_KEY` |
| `anthropic` | `anthropic` | `claude-haiku-4-5-20251001` | `https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` |
| `google` | `google` | `gemini-2.5-flash` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `GEMINI_API_KEY`, fallback `GOOGLE_API_KEY` |
| `custom` | explicit | explicit | explicit | `DECISION_API_KEY` |

`vercel-ai-gateway` aliases `vercel`. An explicit `profile` selects a trusted
named target; an explicit `provider` without a profile selects a fresh target
and does not inherit another target's ambient model or endpoint. Otherwise,
profile defaults and `DECISION_PROVIDER`, `DECISION_MODEL`, `DECISION_ENDPOINT`
apply before preset defaults. See [selection precedence](decision-targets.md#standalone-defaults-and-overrides).
Provider ultimately defaults to `typesafe`; `api` must match a named preset.
`custom` requires **explicit request fields** `api`, `endpoint`, `model`:

```json
{
  "provider": "custom", "api": "system-one",
  "endpoint": "https://decisions.example.com/v1/systemone", "model": "deployment-alias",
  "state": "All checks passed",
  "questions": {"ready": {"type": "boolean", "instructions": "Ready to proceed?"}}
}
```

Explicit model IDs are accepted for compatible endpoints; there is no live
catalog allowlist. Cloudflare's constructed URL requires
`CLOUDFLARE_ACCOUNT_ID` (32 hex characters). The default `typesafe/jev` uses the
generic `/ai/run` text-only wrapper. Explicit `model: "clef"` or `"clef-flash"`
selects `/ai/run/@cf/cloudflare/{model}` and the image-capable flat body
(`@cf/cloudflare/…` model aliases are normalized). Other models need an explicit
compatible endpoint and remain text-only. An explicit endpoint removes the
account-ID requirement. `local` is a deployment alias placeholder, not a
downloaded model.

### Options and generated estimates

`providerOptions` is not unrestricted body injection. OpenRouter forwards the
object under wire key `provider`; Vercel presets forward `providerOptions`.
For example, merge either routing fragment with `state` and `questions`:

```json
{"provider": "openrouter", "providerOptions": {"allow_fallbacks": false}}
```

```json
{"provider": "vercel-evaluate", "providerOptions": {"gateway": {"models": ["typesafe-ai/jev"]}}}
```

Gateway fallback is an **explicit provider option**, not an HTTP retry by this
client, and may bill multiple stages. Consult the gateway's routing contract.
Direct OpenAI accepts only `providerOptions.safety_identifier` (null or a
nonempty printable string up to 64 scalars), forwarded as a top-level body
field. TypeSafe, SubQ, OpenCode, Cloudflare and local adapters reject provider options.

Anthropic and Google require `allowGenerated:true`. They generate schema-bound
answers, **not native probability distributions**. Their boolean probability is
an explicitly prompted estimate with no calibration guarantee. Generated
confidence/distribution fields are rejected, not invented by normalization.

Supported option fragments (merge with `state` and `questions`):

```json
{"provider": "anthropic", "allowGenerated": true, "providerOptions": {"max_tokens": 1024}}
```

```json
{"provider": "google", "allowGenerated": true, "temperature": 0.2, "providerOptions": {"maxOutputTokens": 1024, "topP": 0.9, "topK": 32}}
```

Anthropic only accepts `max_tokens` (default 4096). Google accepts
`maxOutputTokens`, `temperature` (0..2), `topP` (0..1), `topK`; integer limits
must be positive and at most 2147483647. Do not supply Google temperature both
at top level and in options. Top-level temperature is otherwise supported only
by `llama-cpp`, where it rescales the label-logprob readout (default 1; must be
positive, at most 2, and representable for the local math). Other transports
reject it.

### Images

Supply `images: [{"data": "<base64>", "mimeType": "image/png", "type": "image"}]`.
`type` is optional. Data must be nonempty canonical base64, without whitespace,
a URL or a data-URL prefix. No remote image URL is fetched by the client.
Generic validation permits at most 128 images; adapter and byte limits still
apply. It validates encoding and MIME, not image pixels.

| Adapter | Implemented image behavior |
| --- | --- |
| Direct OpenAI `openai-decisions` | Inline `input_image` parts with `image_url` data URLs; PNG/JPEG/WebP/GIF |
| Cloudflare Clef/Flash | `{content_type, base64}` objects; PNG/JPEG/WebP; at most 4 images, 4 MiB decoded each, 8 MiB decoded total, 13 MiB encoded request body. The documented 16-megapixel/image limit is checked by the server, not locally |
| Cloudflare Jev/other models | No images |
| SubQ `system-one` | `{mediaType, base64}` objects; PNG/JPEG/WebP; at most 4 images, 4 MiB decoded each, 8 MiB decoded total, 13 MiB encoded request body |
| `llama-system-one` | Inline image data URL strings; needs a multimodal model and server `--mmproj` |
| `llama-cpp` chat/logprobs | No images; separate from native SystemOne |
| Anthropic | Generated opt-in; inline base64 image source, PNG/JPEG/WebP/GIF |
| Google | Generated opt-in; `inlineData`, PNG/JPEG/WebP through the public request schema |
| TypeSafe, OpenRouter, OpenCode, Vercel | No images; Vercel custom routes to `ai-gateway.vercel.sh` are also rejected |

OpenRouter SystemOne has no documented image wire shape: an image request fails
even if a model catalog advertises vision. Capabilities are not inferred from
model names. Google HEIC/HEIF support in the lower-level generated builder does
not widen the public request MIME allowlist.

For example, in Python after authorization:

```python
import base64
from pathlib import Path
from jev_fabric import Fabric

request = {
    "provider": "openai",
    "state": "Inspect the attached image",
    "images": [{"data": base64.b64encode(Path("frame.png").read_bytes()).decode("ascii"),
                "mimeType": "image/png"}],
    "questions": {"clear": {"type": "boolean", "instructions": "Is the subject clearly visible?"}},
}
with Fabric(max_evaluations=1, max_tokens=10000) as fabric:
    fabric.validate_decision(request)
    result = fabric.decide(request, timeout_ms=30000)
    if result["status"] != "ok":
        raise RuntimeError(result.get("error"))
```

## Results, refusals and exact numbers

A decision result has `status: "ok" | "error"`, `provider`, `api`, `model`,
`answers`, `usage` and `budget`. Canonical native/generated answers are:

| Type | Value |
| --- | --- |
| `boolean` | `probability` in [0,1], not a thresholded truth value |
| `choice` | `choice`, one of the requested keys |
| `score` | `score` in [0,last index], with the request-derived `legend` |
| `refusal` | Provider refusal fields; not a fabricated zero probability |

Choice/score `probabilities` and `confidence` are optional. They are never
filled in when the provider omits them. If supplied, probabilities must cover
exactly the requested keys/indices, each lie in [0,1], and sum within
[0.98,1.02], using exact decimal validation. No renormalization disguises invalid
provider data. A refusal for one question preserves successful siblings;
generated provider-wide refusals expand to refusals for every requested ID.
Other malformed answers invalidate the normalized answer set.

`provenance.kind` is `native`, `generated`, or `token-logprobs`. Local chat
readouts use verified single-token labels and temperature-scaled softmax, not
native classifier probabilities or generated-text guesses. A single evaluation
may make several tokenizer/template/completion requests and deepen `n_probs`
up to 32768; these are distinct readouts, not retries of failed HTTP requests.
Their responses and usage are retained. This is not a calibration guarantee.
Local score readouts use the same index-keyed probability and legend maps,
with original structured criteria retained in the legend.

`raw` retains the original provider JSON AST, including unknown fields. Numeric
lexemes survive native parsing/serialization. `rawJson` retains the original
UTF-8 response text, including whitespace and number spelling. Ordinary
JavaScript `JSON.parse` can round numbers in `raw` **and** normalized answers;
`JSON.stringify(result.raw)` cannot recover them. Keep `rawJson` and use an
exact-number reader when precision matters:

```python
import json
from decimal import Decimal

exact = json.loads(result["rawJson"], parse_float=Decimal)  # Python ints are already exact
```

For the multi-request local adapter, `raw` is a capture array with `path`,
`n_probs`, `httpStatus`, `body` and original response `text`; `rawJson` serializes that array.
Parse an entry's `text` with `parse_float=Decimal` to read that exact server
response. Retain the text itself if original numeric spelling matters.

Pre-dispatch credential and transport failures raise client errors (`ok:false`
in JSONL). Complete non-2xx responses, or malformed JSON/answers/usage, return
`ok:true` with **`result.status:"error"`**, an error object, captured `rawJson`
and known usage. Direct exchanges include `httpStatus`; `rawText` replaces
`raw` when JSON cannot be parsed. Inspect both envelope layers. Oversized or invalid-UTF-8 transport data cannot be
promised a retained result. The local multi-request driver also packages
post-dispatch failures as `status:error` with its captures/accounting.

## Budgets, credentials and transport

`jev` and `decide` share one session evaluation/token budget and run in arrival
order on the same affine client. Zero evaluation or token limits, invalid
preflight and credential failures cause no model dispatch. Each dispatched
evaluation consumes a call; no HTTP call is automatically retried.

Usage is extracted/accounted **before answer validation**, including a billed
response whose answers are malformed. Anthropic input counts include fresh,
cache-creation and cache-read tokens; Google output counts include candidates
and thoughts. Google cached prompt tokens are not counted twice. Conflicting
reported totals, malformed/overflowing counters, or nonzero Google tool-use
counts whose aggregate cannot be established fail closed. Original breakdowns
remain in `rawJson`. Unknown counters are null, never assumed
zero. Missing/unknown usage (`unknown-usage`), invalid usage (`invalid-usage`)
and uncertain dispatch outcomes conservatively stop remaining shared calls.
If reported tokens exceed the cap, the original result is returned with
`budget:{"exhausted":true,"reason":"reported-token-limit"}`; later `jev` and
`decide` calls are blocked. The final bill may exceed your cap. Ordinary call
exhaustion can have an empty reason; always inspect `budget.exhausted`.

Credentials come from the preset key variable, `DECISION_API_KEY` for `custom`,
or `DECISION_CREDENTIAL_COMMAND` (a trusted JSON argv resolver, not shell text).
A JSONL/client `credential` applies only to that request. Decision credentials
are resolved per evaluation, never cached in the shared Jev client, echoed or
logged. They travel over private pipes, including the curl configuration pipe,
not process argv. Do not put credentials into persisted request examples.

The new transport requires **curl 7.82+** and uses private curl execution, not
legacy pooled HTTP. Repeated `--json` chunks in the private stdin configuration
concatenate the body without separators, avoiding curl's configuration-line
limit for full 16 MiB requests. `JEV_FABRIC_HTTP` selects only the unchanged
legacy transport. Curl startup config,
redirects and environment proxies are disabled; HTTPS certificates are verified.
Plain HTTP requires `allowLocal:true` and exactly `127.0.0.1` or `[::1]`
(optionally port 1..65535), not `localhost`, DNS aliases or other loopback
spellings. Local APIs require the opt-in even with HTTPS. Anonymous bearer
requests are allowed only on opted-in exact loopback; Anthropic/Google still
need a key. URL userinfo, queries, fragments and backslashes are rejected.

Endpoint overrides, resolver executables, PATH/curl and CA configuration are
trusted deployment inputs, not a sandbox. An explicit endpoint receives your
selected credential and evidence; never copy one from untrusted model output.

## Size limits and evidence

New decision requests/results and the JSONL line ceiling are 16 MiB (16777216
bytes). The full result, including duplicated AST and escaped `rawJson`, must
fit: a provider response below 16 MiB can still exceed the final envelope cap.
Ordinary serve operations retain their 1 MiB encoded/schema cap. Legacy
`Codec` entry points and `jev` retain 1 MiB; the local chat request planner also
uses that legacy cap. Explicit decision codec entry points do not relax depth
64, 256 fields/object, key length 256 or numeric lexeme length 1024. Local
logprob replies/results alone use a wider structural profile (up to 524288 work
units), still under 16 MiB; capture storage is additionally bounded, not silently
truncated into a successful answer.

Implementation: [`Decision.bend`](../native/Decision.bend),
[`DecisionWire.bend`](../native/DecisionWire.bend),
[`DecisionGenerated.bend`](../native/DecisionGenerated.bend),
[`DecisionLocal.bend`](../native/DecisionLocal.bend), and
[`DecisionHttpCore.bend`](../native/DecisionHttpCore.bend).
Primary references recorded by those modules and the
[routing evidence notes](../native/tests/decision-routing-notes.md):

- [TypeSafe API](https://docs.typesafe.ai/api.md) and [models](https://docs.typesafe.ai/models.md).
- [SubQ Decisions API](https://docs.subq.ai/endpoints/decisions-api/) and [models](https://docs.subq.ai/using-the-api/models/).
- [OpenRouter SystemOne](https://openrouter.ai/docs/client-sdks/typescript/sdks/systemone/README.md) and [request schema](https://openrouter.ai/docs/client-sdks/typescript/models/decisionsrequest.md).
- [Vercel decisions](https://vercel.com/docs/ai-gateway/modalities/decision) and [OpenAI Decisions compatibility](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions).
- [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions.md).
- Cloudflare [Clef](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json) and [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json) input schemas.
- [OpenCode Zen](https://opencode.ai/docs/zen/) and [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
- Anthropic [Messages](https://platform.claude.com/docs/en/api/messages/create) and [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
- Google [GenerationConfig](https://ai.google.dev/api/generate-content#GenerationConfig), [TextResponseFormat](https://ai.google.dev/api/generate-content#TextResponseFormat) and [images](https://ai.google.dev/gemini-api/docs/image-understanding).

These are wire-format references, not live conformance certificates. SubQ is
the one route exercised live for this documentation (2026-10-13,
`subq-snap-preview`): `jev`, `decide` with and without an image, and its 401 and
422 replies. No other paid or live provider calls were performed; model
availability, account access and full vendor conformance are not claimed.
