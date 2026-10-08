import Base
import ../DecisionProfiles.bend as P
import ../DecisionConfig.bend as C
import ../vendor/strict-json/json.bend as J

# Universal laws of the production policy, not a second implementation.
# SCon ranges over every nonempty string; parsing/name validation stays upstream.
law explicit_profile_wins:
  for head: Char
  for tail: String
  for provider: Maybe<&2, J.JSON>
  for ambient: String
  for default: String
  {P.choose_profile(SCon{head, tail}, provider, ambient, default) == SCon{head, tail} : String}

def explicit_profile_wins(head, tail, provider, ambient, default):
  {==}

law explicit_provider_suppresses_profiles:
  for provider: J.JSON
  for ambient: String
  for default: String
  {P.choose_profile("", Some{provider}, ambient, default) == "" : String}

def explicit_provider_suppresses_profiles(provider, ambient, default):
  {==}

law ambient_profile_wins_over_default:
  for head: Char
  for tail: String
  for default: String
  {P.choose_profile("", None{}, SCon{head, tail}, default) == SCon{head, tail} : String}

def ambient_profile_wins_over_default(head, tail, default):
  {==}

law absent_selectors_use_document_default:
  for default: String
  {P.choose_profile("", None{}, "", default) == default : String}

def absent_selectors_use_document_default(default):
  {==}

# Also exercise the consumer: an explicit-provider request bypasses every
# document entry (and its providerOptions), not just the selector helper.
law explicit_provider_bypasses_document:
  for provider: J.JSON
  for entries: List<&2, J.JSON>
  for default: String
  for ambient: String
  {P.apply_document(J.Obj{[J.Member{"provider", provider}]}, P.Document{entries, default}, ambient) == Done{P.Selected{J.Obj{[J.Member{"provider", provider}]}, ""}} : Result<&1, &1, P.Error, P.Selected>}

def explicit_provider_bypasses_document(provider, entries, default, ambient):
  {==}

# Noninterference: changing BOTH ambient inputs cannot change success OR error.
# The request, preset, account and explicit provider value are all arbitrary.
law explicit_provider_discards_ambient_target:
  for request: J.JSON
  for settings: C.Settings
  for model_a: String
  for endpoint_a: String
  for model_b: String
  for endpoint_b: String
  for account: String
  for provider: J.JSON
  {C.configure_explicit(request, settings, model_a, endpoint_a, account, Some{provider}) == C.configure_explicit(request, settings, model_b, endpoint_b, account, Some{provider}) : Result<&1, &1, U32 & String, C.Settings>}

def explicit_provider_discards_ambient_target(request, settings, model_a, endpoint_a, model_b, endpoint_b, account, provider):
  {==}

# Whole-field overlay for arbitrary old/new JSON, including nested/empty objects.
# No old subtree may survive. This asserts the exact output, not another merge.
law provider_options_replaced_whole:
  for old: J.JSON
  for replacement: J.JSON
  {P.merge(J.Obj{[J.Member{"providerOptions", old}]}, J.Obj{[J.Member{"providerOptions", replacement}]}) == Done{J.Obj{[J.Member{"providerOptions", replacement}]}} : Result<&1, &1, P.Error, J.JSON>}

def provider_options_replaced_whole(old, replacement):
  {==}

# The shadowed subtree is irrelevant even with arbitrary other fields present.
law shadowed_provider_options_are_irrelevant:
  for old_a: J.JSON
  for old_b: J.JSON
  for base_tail: List<&2, J.JSON>
  for replacement: J.JSON
  for request_tail: List<&2, J.JSON>
  {P.merge(J.Obj{Con{J.Member{"providerOptions", old_a}, base_tail}}, J.Obj{Con{J.Member{"providerOptions", replacement}, request_tail}}) == P.merge(J.Obj{Con{J.Member{"providerOptions", old_b}, base_tail}}, J.Obj{Con{J.Member{"providerOptions", replacement}, request_tail}}) : Result<&1, &1, P.Error, J.JSON>}

def shadowed_provider_options_are_irrelevant(old_a, old_b, base_tail, replacement, request_tail):
  match request_tail:
    case Nil{}: {==}
    case Con{J.Null{}, tail}: {==}
    case Con{J.Boolean{b}, tail}: {==}
    case Con{J.Num{n}, tail}: {==}
    case Con{J.Str{s}, tail}: {==}
    case Con{J.Arr{items}, tail}: {==}
    case Con{J.Obj{fields}, tail}: {==}
    case Con{J.Member{key, value}, tail}: {==}

# Branch lemma: both equality witnesses are discharged by computation below.
# They are separate affine proof inputs, not additional assumptions of the law.
law canonical_idempotent_branch:
  for provider: String
  for matched: Bool
  for first: {C.canonical(provider) == Bool.pick(String, matched, "vercel", provider) : String}
  for second: {C.canonical(provider) == Bool.pick(String, matched, "vercel", provider) : String}
  {C.canonical(C.canonical(provider)) == C.canonical(provider) : String}

def canonical_idempotent_branch(provider, matched, first, second):
  match matched:
    case False{}:
      Equal.cong(String, String, x => C.canonical(x), C.canonical(provider), provider, first)
    case True{}:
      Equal.trans(String, C.canonical(C.canonical(provider)), "vercel", C.canonical(provider),
        Equal.cong(String, String, x => C.canonical(x), C.canonical(provider), "vercel", first),
        Equal.sym(String, C.canonical(provider), "vercel", second))

law canonical_provider_is_idempotent:
  for +provider: String
  {C.canonical(C.canonical(provider)) == C.canonical(provider) : String}

def canonical_provider_is_idempotent(provider):
  canonical_idempotent_branch(provider, String.eq(provider, "vercel-ai-gateway"), {==}, {==})
