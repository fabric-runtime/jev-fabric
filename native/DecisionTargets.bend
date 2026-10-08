import Base
import ./Codec.bend as Codec
import ./DecisionProfiles.bend as Profiles
import ./DecisionConfig.bend as Config
import ./DecisionWire.bend as Wire
import ./DecisionLocal.bend as Local
import ./Jev.bend as Jev
import ./Input.bend as Input
import ./vendor/strict-json/json.bend as J

def Error() -> Type:
  U32 & String

type PreparedTarget is Data:
  PreparedTarget{config: Config.Settings, request: J.JSON, body: String, profile: String}

# These are exactly the dispatch adapter's preflight constraints, not a second
# approximation of its schema. Nothing here resolves credentials or dispatches.
def body(request: J.JSON, api: String, model: String, local: Bool) -> Result<&1, &1, Error, String>:
  match local:
    case True{}:
      do Result<&1, &1, Error, String>:
        Local.preflight(request)
        return ""
    case False{}: Wire.body(request, api, model)

def prepare(request: J.JSON, +config: Config.Settings, profile: String) -> Result<&1, &1, Error, PreparedTarget>:
  Config.Settings{provider, +api, endpoint, model, key, auth, local} = config
  do Result<&1, &1, Error, PreparedTarget>:
    +effective : J.JSON <- Profiles.merge(request, J.Obj{[J.Member{"provider", J.Str{provider}}]})
    text : String <- body(effective, api, model, String.eq(api, "llama-cpp"))
    return PreparedTarget{config, effective, text, profile}

def selected(value: Profiles.Selected, provider: String, model: String, endpoint: String, account: String) -> Result<&1, &1, Error, PreparedTarget>:
  match value:
    case Profiles.Selected{request, profile}:
      do Result<&1, &1, Error, PreparedTarget>:
        +checked : J.JSON <- Wire.validate_request(request)
        config : Config.Settings <- Config.resolve(checked, provider, model, endpoint, account)
        prepare(checked, config, profile)

def resolve_with(text: String, profiles: String, selector: String, provider: String, model: String, endpoint: String, account: String) -> Result<&1, &1, Error, PreparedTarget>:
  do Result<&1, &1, Error, PreparedTarget>:
    request : J.JSON <- Codec.read_with_limit(text, 16777216)
    value : Profiles.Selected <- Profiles.apply(request, profiles, selector)
    selected(value, provider, model, endpoint, account)

def image_support(+provider: String, +api: String, +model: String, endpoint: String) -> String:
  Bool.pick(String, Config.vercel_endpoint(endpoint) || Bool.not(Config.image_capable(provider, api, model)), "unsupported",
    Bool.pick(String, String.eq(api, "llama-system-one"), "model-dependent", "supported"))

def profile_field(profile: String) -> List<&2, J.JSON>:
  match profile:
    case SNil{}: Nil{}
    case text: [J.Member{"profile", J.Str{text}}]

def resolution(ready: PreparedTarget) -> J.JSON:
  match ready:
    case PreparedTarget{Config.Settings{+provider, +api, +endpoint, +model, key, auth, local}, +request, body, profile}:
      J.Obj{List.append(&2, J.JSON, [
        J.Member{"target", J.Obj{List.append(&2, J.JSON, [
          J.Member{"provider", J.Str{provider}}, J.Member{"api", J.Str{api}},
          J.Member{"model", J.Str{model}}, J.Member{"endpoint", J.Str{endpoint}},
          J.Member{"allowLocal", J.Boolean{local}},
          J.Member{"allowGenerated", J.Boolean{Local.enabled(Codec.field(request, "allowGenerated"))}}
        ], List.append(&2, J.JSON, Wire.optional_member("providerOptions", Codec.field(request, "providerOptions")), Wire.optional_member("temperature", Codec.field(request, "temperature"))))}},
        J.Member{"credential", J.Obj{[J.Member{"env", J.Str{key}}, J.Member{"resolved", J.Boolean{False{}}}]}},
        J.Member{"imageSupport", J.Str{image_support(provider, api, model, endpoint)}},
        J.Member{"generated", J.Boolean{String.eq(api, "anthropic") || String.eq(api, "google")}}
      ], profile_field(profile))}

def nonempty_profiles(result: Result<&1, &1, Error, String>) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    +text : String <- result
    Codec.guard(Bool.not(String.is_empty(text)), "Configured decision profiles document is empty")
    return text

def profiles_file(path: String) -> IO(Result<&1, &1, Error, String>):
  match path:
    case SNil{}: IO.pure(Result<&1, &1, Error, String>, Done{""})
    case other:
      do IO<Result<&1, &1, Error, String>>:
        result : Result<&1, &1, Error, String> <- Input.read_limit(other, 65536)
        return nonempty_profiles(result)

def profiles_source(inline: Result<&1, &1, Error, String>, path: String) -> IO(Result<&1, &1, Error, String>):
  match inline:
    case Done{text}: IO.pure(Result<&1, &1, Error, String>, nonempty_profiles(Done{text}))
    case Fail{error}: profiles_file(path)

def configured(text: String, profiles: Result<&1, &1, Error, String>, selector: String, provider: String, model: String, endpoint: String, account: String) -> Result<&1, &1, Error, PreparedTarget>:
  do Result<&1, &1, Error, PreparedTarget>:
    document : String <- profiles
    resolve_with(text, document, selector, provider, model, endpoint, account)

def resolve(text: String) -> IO(Result<&1, &1, Error, PreparedTarget>):
  do IO<Result<&1, &1, Error, PreparedTarget>>:
    inline : Result<&1, &1, Error, String> <- IO.get_env("DECISION_PROFILES")
    path : String <- Jev.env("DECISION_PROFILES_FILE")
    profiles : Result<&1, &1, Error, String> <- profiles_source(inline, path)
    selector : String <- Jev.env("DECISION_PROFILE")
    provider : String <- Jev.env("DECISION_PROVIDER")
    model : String <- Jev.env("DECISION_MODEL")
    endpoint : String <- Jev.env("DECISION_ENDPOINT")
    account : String <- Jev.env("CLOUDFLARE_ACCOUNT_ID")
    return configured(text, profiles, selector, provider, model, endpoint, account)

def encoded(result: Result<&1, &1, Error, PreparedTarget>) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    ready : PreparedTarget <- result
    Codec.encode_with_limit(resolution(ready), 16777216)

def offline(text: String) -> IO(Result<&1, &1, Error, String>):
  do IO<Result<&1, &1, Error, String>>:
    result : Result<&1, &1, Error, PreparedTarget> <- resolve(text)
    return encoded(result)
