# Decision targets and profiles

A target binds a provider, wire API, model and endpoint. A profile gives a trusted
target a reusable name. Switching targets changes the next decision, not the
connection or its shared evaluation/token budget. Legacy `jev` is unchanged.

See [lossless decisions](decisions.md) for protocols, images, credentials,
probability provenance and transport limits. Profile defaults do not prove that
a model is available or that a credential works.

## One portable profile document

Use the same document in standalone clients, the CLI, and Pi Fabric:

```json
{
  "version": 1,
  "defaultProfile": "fast",
  "profiles": {
    "fast": { "provider": "typesafe", "model": "jev-latest" },
    "vision": { "provider": "openai", "model": "gpt-6-luna" },
    "local": { "provider": "llama.cpp", "model": "local", "allowLocal": true }
  }
}
```

The [JSON Schema](decision-profiles.schema.json) assists editors. Runtime
validation additionally requires an existing default profile, supported routes,
and valid provider-specific options. There are at most 128 profiles and the
whole document is at most 64 KiB in UTF-8. Names use `A-Z`, `a-z`, digits, `_`,
`.` and `-`, with 1–128 characters; `__proto__`, `prototype` and `constructor`
are reserved. Unknown fields and duplicate JSON keys are rejected natively.

A target requires `provider`; its other allowed fields are `api`, `model`,
`endpoint`, `allowLocal`, `allowGenerated`, `providerOptions` and `temperature`.
Profiles never contain state, questions, images or credential fields. Do not put
secrets in model IDs, endpoints or provider options either. An endpoint is a
trusted destination for evidence and credentials, not a value to copy from an
untrusted model answer.

## Standalone defaults and overrides

- `DECISION_PROFILES` contains the document as JSON. It takes precedence over
  `DECISION_PROFILES_FILE`, an explicit trusted file path. No profile file is
  discovered implicitly from the working directory.
- An explicit request `profile` overrides `DECISION_PROFILE`, which overrides
  the document's `defaultProfile`.
- An explicit `provider` without a profile selects a fresh target: it bypasses
  default-profile routing and ambient `DECISION_MODEL`/`DECISION_ENDPOINT`.
- Explicit request fields can override a selected profile, but a conflicting
  provider is rejected. Choose another profile or an explicit unprofiled target
  instead of mixing credentials and endpoints across providers.
- Provider options replace the selected options object as a whole; they are not
  recursively merged. A bad profile/configuration fails closed.

Without a selected profile or explicit provider, existing `DECISION_PROVIDER`,
`DECISION_MODEL` and `DECISION_ENDPOINT` defaults still apply. Provider presets
supply any remaining defaults. Opt-ins for local transport and generated
estimates remain explicit.

## CLI: resolve before dispatch

Given a request file containing state/questions and optional images:

```sh
export DECISION_PROFILES_FILE=examples/decision-profiles.json

# Offline: no credential lookup, resolver command, curl, or model request.
jev-fabric -- resolve-decision --profile vision request.json

# Explicit authorized model dispatch.
jev-fabric -- decide --profile vision --timeout-ms 30000 request.json 10000

# Select a different target without editing the request file.
jev-fabric -- resolve-decision --provider openai --model gpt-6-luna request.json
```

`--provider`, `--model`, `--profile`, `--api` and `--endpoint` are routing
controls for `decide` and `resolve-decision`. Duplicate flags are errors. Keep
secrets out of flags. Model selection alone does not enable generated estimates
or plain-HTTP local transport; put their opt-ins in a trusted profile/request.

## Clients: immutable views, one budget

```ts
const fabric = await Fabric.open({
  decisionProfiles: profiles,
  maxEvaluations: 2,
  maxTokens: 10000,
});
try {
  const vision = fabric.withDecisionTarget('vision');
  const plan = await vision.resolveDecision(evidence);
  // After authorization, dispatch the same evidence.
  const result = await vision.decide(evidence);
  // Another bound view uses the SAME connection and remaining budget.
  const fast = fabric.withDecisionTarget({ provider: 'typesafe', model: 'jev-latest' });
} finally {
  await fabric.close();
}
```

`evidence` contains `state`, `questions` and optional `images`. A bound view
rejects routing overrides in evidence. Target objects are copied/frozen, so
mutating an original object cannot retarget the view. Named views resolve once
on first successful use and freeze that resolved target; later profile-file
edits cannot silently retarget them. Failed preflight can be retried. Views do
not own or close the parent session. Timeout and one-request credentials remain call options,
not persistent target fields.

Python has the equivalent `Fabric(decision_profiles=profiles)`,
`with_decision_target(...)` and `resolve_decision(evidence)` methods. Explicit
request routing and `fabric.decide(...)` remain available without a bound view.

## Offline resolution contract

`resolveDecision` in JSONL/TypeScript, `resolve_decision` in Python, and
`resolve-decision` in the CLI all perform routing and actual adapter preflight.
They detect incompatible images/options, missing opt-ins and bad endpoints
without spending an evaluation or retrieving a key.

The result contains the resolved `target`, `credential.env` and
`credential.resolved: false`, image support, generated/native classification,
and the selected profile when applicable. It never returns the state, images,
request body or a credential value. Preflight is not an authentication test or
proof of upstream model availability.

The `decision-targets` capability identifies this contract. New clients fail
clearly on an older binary rather than pretending profile selection succeeded.

## Pi Fabric

Place the document under trusted `fabric.json` → `jev.decisionProfiles`.
`jev.decisionProfile` optionally selects a named profile independently of the
document's default. This selects decision models, not Main's chat model or the
auto-approval classifier. Pi's additive `jev.decide` uses the native lossless
contract; legacy `jev.evaluate` retains its strict response contract.

Pi resolves credentials host-side for the selected provider, never in guest
code. Guest-supplied endpoints cannot redirect a host credential to an arbitrary
server: use a trusted profile or registered model endpoint. Capability discovery
is not consent to send evidence, and selecting generated estimates does not make
them calibrated native probabilities.

The native transport permits 16 MiB frames; Pi's program input/output and tool
result limits still apply. Keep full `rawJson` in approved storage when needed,
and return a small projection rather than silently truncating evidence.
