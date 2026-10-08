# Proof-led verification

Bend's type/effect checks are not a substitute for semantic laws. Remove a
runtime case only when its obligation is discharged by a checked law on the
actual implementation, or it is already witnessed at the same boundary.
Compiler/Base correctness and foreign-code behavior remain explicit assumptions.

## Existing policy reductions

`native/tests/time-proofs.bend` remains unchanged. These five concrete cases in
`time-core.bend` were removed after mapping their obligations:

| Removed example | Universal law | Remaining witness |
| --- | --- | --- |
| Empty configuration uses fallback 50 | `omitted_configuration_uses_default` | Real CLI default handling and timer-free operations |
| Remaining time after expiration is zero | `elapsed_time_is_subtracted_not_renewed` | Asymmetric subtraction, exact-deadline zero, real shared-budget expiration |
| Two ordinary local-cap examples | `local_cap_is_applied_before_narrowing` | A value above U32 range, plus actual local deadlines |
| Serve maximum is one day | `serve_connection_may_last_a_day` | CLI parsing, help, handshake and session integration |

The remaining native `core`, `policy-core`, and `time-core` assertions compile
through one `policy-checks.bend` executable, exercised once by `safety.test.ts`.
This removes two independent compilation jobs, not any parser, floating-point,
foreign-code or overflow coverage. Individual source fixtures remain available
for focused investigation. The full suite still compiles every other required
fixture and performs the complete safety audit; it does not trust stale binaries.

## Boundaries that still need tests

- JSON/UTF-8 parsing, encoding and exact raw provider evidence.
- Real protocol differences, image encodings and response-envelope variants.
- Native process, filesystem, clock, HTTP and numerical foreign code.
- Authentication/dispatch ordering and shared-budget behavior in the driver.
- TypeScript/Python normalization, ABI shapes and immutable client handles.
- Host settings propagation, persistence and lazy first-use behavior.

Use one conformance corpus across independent implementations where practical;
it is not redundant merely because the same input reaches different code.
Do not delete adversarial cases or previously observed regressions to hit a
numerical test-count target. Pi's verified-kernel bridge tests are retained: the
laws do not prove the TypeScript producers or emitted ABI adapters.

See [decision-proof-coverage.md](decision-proof-coverage.md) for the decision
policy laws and their exact test replacements.
