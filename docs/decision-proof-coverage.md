# Decision proof coverage

`native/tests/decision-proofs.bend` imports the production functions. Its laws use universal variables, with no unsafe definitions, holes or postulates. `DecisionProfiles.choose_profile` is only an extraction of the original expression in `apply_document`; validation order and behavior are unchanged. The proof addition does not change `DecisionConfig` behavior.

## Checked contracts

- `explicit_profile_wins`: every nonempty explicit selector wins over any provider, ambient selector and default.
- `explicit_provider_suppresses_profiles`: with no explicit selector, every present provider suppresses ambient/default profiles.
- `ambient_profile_wins_over_default` / `absent_selectors_use_document_default`: remaining precedence paths, for arbitrary names/defaults.
- `explicit_provider_bypasses_document`: `apply_document` returns an explicit-provider-only request unchanged, with no profile, for arbitrary document entries/default/ambient values.
- `explicit_provider_discards_ambient_target`: arbitrary changes to both ambient model and endpoint cannot affect `configure_explicit`'s result when a provider is present, including failures. Request, preset, account and provider value are universal.
- `provider_options_replaced_whole`: merging singleton `providerOptions` fields returns exactly the replacement JSON, for arbitrary old/replacement trees (including empty and nested objects).
- `shadowed_provider_options_are_irrelevant`: arbitrary changes to the old `providerOptions` subtree cannot change a merge when both objects start with that field, even with arbitrary remaining fields. Exhaustive JSON constructor cases discharge the production first-match lookup.
- `canonical_provider_is_idempotent`: canonicalizing any provider twice equals canonicalizing it once. `canonical_idempotent_branch` is an auxiliary case lemma, not a separate requirement; its equality inputs are supplied by reflexivity in the universal theorem.

## Removal → law ledger

Laws compile-checked **before** removal. Only two assertions in `native/tests/decision-targets.test.ts` were removed; no test blocks or matrices were deleted.

| Removed example | Superseding law | Retained integration witness |
| --- | --- | --- |
| Explicit `openrouter` with ambient `openrouter`/model/endpoint uses the preset model | `explicit_provider_discards_ambient_target` (no same/different-provider distinction) | Explicit `openai` against ambient router checks **both** preset model and endpoint; ambient-only and request model/endpoint overrides remain |
| Request `providerOptions: {}` replaces the profile object | `provider_options_replaced_whole`, `shadowed_provider_options_are_irrelevant` | Nonempty `{only: ['y']}` replaces `{order: ['x']}` through complete offline resolution |

All four profile precedence paths retain runtime witnesses. Alias compatibility, preset/default values, parsing, Unicode scalar limits, credentials, no-network checks, CLI flags, protocol/JSON boundaries and invalid input matrices remain. `native/tests/decision-config.test.ts` is untouched: idempotence does not prove particular alias mappings or preset values.

## Trust and scope

The proof root is registered in `native/trust.json` under `proofs`. `scripts/check-native-safety.ts` auto-discovers `.bend` files under `native` and `examples/native`; tests need not be drivers. Proof registration additionally enforces the transitive pure closure and implemented laws.

The selection laws operate **after** structural validation; they do not claim malformed selectors succeed. The document-bypass law is for a provider-only request. The merge laws do not prove arbitrary field permutations, JSON validity, serialization or preservation of every unrelated field. Environment isolation is a pure configuration-helper property, not an IO theorem. Compiler/Base correctness and compiled/foreign IO behavior remain trust boundaries, hence the retained integration witnesses. No deletion is justified solely by alias idempotence.

## Verification

- Bend 2.0.36 `--help` specifies `--check-only` (not `-c`); `bend native/tests/decision-proofs.bend --check-only`: **ALL PROOFS CHECK**.
- Full native safety audit: **81 modules, 22 pure modules, 4 proof roots, 11 explicit foreign effects**; no unsafe definitions or proof holes.
- Fresh direct builds: `bend native/tests/decision-targets.bend -o build/test-decision-targets` and `bend native/tests/decision-target-cli.bend -o build/test-decision-target-cli`, both successful. Only after **both** builds succeeded in the same `&&` command chain, `JEV_NATIVE_PREBUILT=1 bun test native/tests/decision-targets.test.ts`: **20 pass, 0 fail, 564 assertions**. The flag skipped redundant helper builds; neither fixture was stale, and the main executable was neither built nor used.
- Optional `bend native/tests/decision-proofs.bend --verdict` failed before independent kernel checking: Lean v4.34.0 is unavailable (`lean` not on PATH; no built `BENDTT` kernel). Thus these are compiler-checked laws, **not** an independently kernel-verified result.
