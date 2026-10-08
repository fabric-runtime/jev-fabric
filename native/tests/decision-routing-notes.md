# Isolated decision routing and transport probes

These fixtures compile directly; no shared build or trust manifest is used:

```sh
bun test native/tests/decision-config.test.ts
bend native/tests/decision-http-core.bend -o /tmp/decision-http-core && /tmp/decision-http-core
bend native/tests/codec-decision.bend -o /tmp/codec-decision && /tmp/codec-decision
bun test native/tests/decision-transport.test.ts
```

`decision-transport.test.ts` compiles its own `decision-http-probe.bend` in a temporary directory. It makes only loopback HTTP requests and synthetic-key/fake-curl probes, never model calls.

## Interfaces and limits

- `DecisionConfig.Settings`: provider, api, endpoint, model, key_env, auth, allow_local (in that order).
- `DecisionConfig.providers()` returns13 static descriptors (12 canonical presets plus custom, no alias duplicate), including provider/api/defaultModel/endpoint/credentialEnv/imageSupport/generated. It never reads environment values or performs live discovery.
- `DecisionConfig.resolve(request, provider_env, model_env, endpoint_env, account)` is pure. Driver environment fallbacks are DECISION_PROVIDER/MODEL/ENDPOINT and CLOUDFLARE_ACCOUNT_ID. Request values override environment values; custom requires explicit request api/endpoint/model and DECISION_API_KEY.
- `DecisionHttp.exchange(url, key, body, timeout, allow_local, auth)` returns `IO(Http.Reply)`, where `type Response is Data: Response{status:U32,bytes:List<&2,U32>}` and `Reply = Result<...,Response>`. All HTTP statuses retain bounded raw bytes, including redirects (never followed) and non2xx. Policy/transport failures remain sanitized `Fail`.
- `DecisionHttp.post(...)` retains the original bytes-result signature via `PostResult`; it wraps exchange with a2xx guard. Non2xx errors retain status but omit body. Both use one fixed-argv curl through Process.capture: no shell, extra runtime, temp files, pooling, retry, redirects, environment proxies or curlrc configuration.
- Curl>=7.82 is required. Strict object JSON is validated before private stdin configuration. Repeated `json` directives concatenate fragments (each<=16384 scalars/64KiB UTF-8), avoiding curl's config-line limit. Only a fragment-leading literal`@` is replaced by`\u0040` so curl cannot interpret it as@file/@-. JSON values and numeric lexemes are unchanged; the small expansion is charged against the16MiB transmitted-body cap. Keys/body/URLs never enter argv, and errors never echo inputs or stderr.
- `Codec.read_with_limit`, `validate_with_limit`, `encode_with_limit`, `decode_utf8_with_limit`, `read_bytes_with_limit`: explicit byte cap up to 16 MiB, existing structural and comparison limits. Original functions retain 1 MiB and original diagnostics.
- `Codec.read_profile(text, bytes, work)`, `validate_profile(value, bytes, work)`, `encode_profile(value, bytes, work)`, `read_bytes_profile(bytes, limit, work)` are explicitly scoped to local logprob replies/results, NOT generic request or normalization inputs. Maximum bytes 16 MiB, work/node jobs 524288, key-comparison work 32*work (at most16 MiB), writer jobs 4*work. Depth64, object fields/key length256, numeric lexeme1024 remain fixed. High-work scanners count structural delimiters/quote starts, while byte limits bound lexical scan work; work<=32768 uses the original scanner. Real32768 token/logprob/bytes entries are tested.
- HTTP only accepts exact127.0.0.1 or[::1], numeric ports1..65535, optional paths, and allowLocal:true. Userinfo, query, fragments and backslashes are rejected. Empty bearer auth or auth:none is accepted only on exact loopback with allowLocal. Anthropic and Google always require a key.
- The driver requires Process.capture capacity16777220 plus escaped stdin configurations. `native/posix.c` supplies this decision-sized capture ceiling; legacy Http/HttpCore retain their original validation limits.

## Official source evidence

Fetched2026-10-08. Documentation verifies formats/defaults, not credentialed live model availability.

- TypeSafe: https://docs.typesafe.ai/api.md and https://docs.typesafe.ai/models.md — POST https://api.typesafe.ai/v1/systemone, jev-latest; text-only.
- OpenRouter: https://openrouter.ai/docs/client-sdks/typescript/sdks/systemone/README.md and https://openrouter.ai/docs/client-sdks/typescript/models/decisionsrequest.md — current /api/v1/systemone, typesafe/jev-1.13, state/questions and provider preferences. No documented images field. Images deliberately fail closed, including vision-looking model names. No inferred OpenRouter image wire format.
- Vercel: https://vercel.com/docs/llms-full.txt, https://vercel.com/docs/ai-gateway/modalities/decision, https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions — /typesafe/v1/systemone and /v1/evaluate use typesafe-ai/jev; /v1/decisions uses openai/gpt-6-luna-decisions. Vercel image requests fail closed, including custom routes to ai-gateway.vercel.sh.
- OpenAI: https://developers.openai.com/api/docs/guides/decisions.md — POST https://api.openai.com/v1/decisions, gpt-6-luna, inline input_image with image_url data URLs.
- Cloudflare compatibility default remains `typesafe/jev` at `/client/v4/accounts/{account}/ai/run` (text-only wrapper); known Clef selectors explicitly choose the direct paths below.
- Cloudflare: https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json and https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json — POST /client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef[-flash]. Body.model is short selector clef or clef-flash. images accepts data URLs or {content_type,base64}; PNG/JPEG/WebP, max4 images,4 MiB/16 megapixels each,8 MiB decoded total,13 MiB whole request. Only these verified model selectors are image-capable; unknown/custom models and TypeSafe/Jev models are not inferred capable.
- OpenCode: https://opencode.ai/docs/zen/ — /zen/v1/systemone, jev-1.13, OPENCODE_API_KEY.
- llama.cpp: https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md — native /v1/systemone supports images (alias of files) as inline image data URLs, standard state/questions, needs a multimodal model and --mmproj. Dedicated provider/API llama-system-one distinguishes this from the text/logprob llama-cpp adapter. Server-local model alias is deployment-specific (default local is an alias placeholder, not a claimed downloaded model).
- Anthropic: https://platform.claude.com/docs/en/api/messages/create.md — /v1/messages, claude-haiku-4-5-20251001, x-api-key, anthropic-version2023-06-01. Requires allowGenerated:true; wire module owns generated output/image schema.
- Google: https://ai.google.dev/gemini-api/docs/quickstart — /v1beta/models/{model}:generateContent, gemini-2.5-flash, x-goog-api-key from GEMINI_API_KEY. Requires allowGenerated:true; wire module owns generated output/image schema.
