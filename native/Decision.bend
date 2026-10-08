import Base
import ./Codec.bend as Codec
import ./Core.bend as Core
import ./JevCore.bend as Policy
import ./Jev.bend as Jev
import ./Credentials.bend as Credentials
import ./DecisionWire.bend as Wire
import ./DecisionConfig.bend as Config
import ./DecisionTargets.bend as Targets
import ./DecisionHttp.bend as Http
import ./DecisionHttpCore.bend as HttpPolicy
import ./DecisionLocal.bend as Local
import ./Scope.bend as Scope
import ./vendor/strict-json/json.bend as J

def limit() -> U32:
  16777216

def Error() -> Type:
  U32 & String

def encoded(value: J.JSON, api: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, String>:
  match api:
    case Some{J.Str{"llama-cpp"}}:
      Codec.encode_profile(value, limit(), 524288)
    case other:
      Codec.encode_with_limit(value, limit())

def encode(+value: J.JSON) -> Result<&1, &1, Error, String>:
  encoded(value, Codec.field(value, "api"))

type Prepared is Data:
  Prepared{config: Config.Settings, request: J.JSON, body: String}

def stop_budget(budget: Core.Budget) -> Core.Budget:
  match budget:
    case Core.Budget{remaining, used, spent, cap}:
      Core.Budget{0n, used, spent, cap}

type Usage is Data:
  Known{input: Nat, output: Nat}
  Unknown{}
  Invalid{}

def usage_of(value: Result<&1, &1, Error, Maybe<&1, Nat & Nat>>) -> Usage:
  match value:
    case Done{Some{(input, output)}}:
      Known{input, output}
    case Done{None{}}:
      Unknown{}
    case Fail{error}:
      Invalid{}

def unknown_usage() -> J.JSON:
  J.Obj{[J.Member{"input_tokens", J.Null{}}, J.Member{"output_tokens", J.Null{}}]}

def usage_value(counts: Usage) -> J.JSON:
  match counts:
    case Known{input, output}:
      J.Obj{[J.Member{"input_tokens", J.Num{Nat.show(input)}}, J.Member{"output_tokens", J.Num{Nat.show(output)}}]}
    case other:
      unknown_usage()

def overshot(budget: Core.Budget) -> Core.Budget:
  match budget:
    case Core.Budget{remaining, used, spent, +cap}:
      Core.Budget{0n, used, 1n+cap, cap}

def accounted(budget: Core.Budget, input: Nat, output: Nat, over: Bool) -> Core.Budget & String:
  match over:
    case True{}:
      (overshot(budget), "reported-token-limit")
    case False{}:
      (Core.account(budget, Nat.add(input, output)), "")

def account_known(+budget: Core.Budget, +input: Nat, +output: Nat) -> Core.Budget & String:
  Core.Budget{remaining, used, spent, +cap} = budget
  accounted(budget, input, output, Nat.is_gt(input, cap) || Nat.is_gt(output, cap) || Nat.is_gt(Nat.add(input, output), Nat.sub(cap, spent)))

def account(budget: Core.Budget, usage: Usage) -> Core.Budget & String:
  match usage:
    case Known{input, output}:
      account_known(budget, input, output)
    case Unknown{}:
      (stop_budget(budget), "unknown-usage")
    case Invalid{}:
      (stop_budget(budget), "invalid-usage")

def exhausted(budget: Core.Budget) -> Bool:
  match budget:
    case Core.Budget{+remaining, used, +spent, +cap}:
      Nat.is_eq(remaining, 0n) || Nat.is_ge(spent, cap)

def decorate(value: J.JSON, +budget: Core.Budget, reason: String) -> J.JSON:
  match value:
    case J.Obj{fields}:
      J.Obj{Con{J.Member{"budget", J.Obj{[
        J.Member{"exhausted", J.Boolean{exhausted(budget)}},
        J.Member{"reason", J.Str{reason}},
      ]}}, fields}}
    case other:
      other

def status_fields(fields: List<&2, J.JSON>, present: Maybe<&2, J.JSON>) -> J.JSON:
  match present:
    case Some{value}:
      J.Obj{fields}
    case None{}:
      J.Obj{Con{J.Member{"status", J.Str{"ok"}}, fields}}

def status(value: J.JSON) -> J.JSON:
  match value:
    case J.Obj{+fields}:
      status_fields(fields, Codec.find_field(fields, "status"))
    case other:
      other

def raw_field(text: String, parsed: Result<&1, &1, Error, J.JSON>) -> J.JSON:
  match parsed:
    case Done{value}:
      J.Member{"raw", value}
    case Fail{e}:
      J.Member{"rawText", J.Str{text}}

def invalid_response(
  config: Config.Settings,
  +text: String,
  usage: Usage,
  error: Error,
) -> J.JSON:
  Config.Settings{provider, api, endpoint, model, key_env, auth, allow_local} = config
  (code, message) = error
  J.Obj{[
    J.Member{"status", J.Str{"error"}},
    J.Member{"provider", J.Str{provider}}, J.Member{"api", J.Str{api}}, J.Member{"model", J.Str{model}},
    J.Member{"answers", J.Obj{[]}}, J.Member{"usage", usage_value(usage)},
    J.Member{"rawJson", J.Str{text}},
    J.Member{"error", J.Obj{[J.Member{"code", J.Num{U32.show(code)}}, J.Member{"message", J.Str{message}}]}},
    raw_field(text, Codec.read_with_limit(text, limit())),
  ]}

def normalized(
  settings: Policy.Settings, key: String, +budget: Core.Budget, reason: String,
  config: Config.Settings, text: String,
  usage: Usage,
  result: Result<&1, &1, Error, J.JSON>,
) -> Jev.Returned:
  match result:
    case Done{value}:
      Policy.returned(settings, budget, key, Done{decorate(status(value), budget, reason)})
    case Fail{error}:
      Policy.returned(settings, budget, key, Done{decorate(invalid_response(config, text, usage, error), budget, reason)})

def finished_account(settings: Policy.Settings, key: String, config: Config.Settings, text: String, usage: Usage, result: Result<&1, &1, Error, J.JSON>, counted: Core.Budget & String) -> Jev.Returned:
  match counted:
    case (budget, reason):
      normalized(settings, key, budget, reason, config, text, usage, result)

def reply_for_status(ok: Bool, +http_status: U32, text: String, request: J.JSON, provider: String, api: String, model: String) -> Result<&1, &1, Error, J.JSON>:
  match ok:
    case True{}: Wire.reply(text, request, provider, api, model)
    case False{}: Fail{(http_status, "decision HTTP status " ++ U32.show(http_status))}

def with_http_status(result: Jev.Returned, http_status: U32) -> Jev.Returned:
  match result:
    case (client, Done{J.Obj{fields}}):
      (client, Done{J.Obj{Con{J.Member{"httpStatus", J.Num{U32.show(http_status)}}, fields}}})
    case other:
      other

def responded(
  settings: Policy.Settings, budget: Core.Budget, key: String,
  +config: Config.Settings, request: J.JSON, +text: String, +http_status: U32,
) -> Jev.Returned:
  Config.Settings{provider, +api, endpoint, model, key_env, auth, allow_local} = config
  +usage = usage_of(Wire.raw_usage(text, api))
  finished_account(settings, key, config, text, usage, reply_for_status(U32.is_ge(http_status, 200) && U32.is_lt(http_status, 300), http_status, text, request, provider, api, model), account(budget, usage))

def decoded_response(settings: Policy.Settings, budget: Core.Budget, key: String, config: Config.Settings, request: J.JSON, http_status: U32, text: Result<&1, &1, Error, String>) -> Jev.Returned:
  match text:
    case Fail{error}:
      Policy.returned(settings, stop_budget(budget), key, Fail{error})
    case Done{value}:
      responded(settings, budget, key, config, request, value, http_status)

def received(
  settings: Policy.Settings, budget: Core.Budget, key: String,
  config: Config.Settings, request: J.JSON,
  response: Result<&1, &1, Error, Http.Response>,
) -> Jev.Returned:
  match response:
    case Fail{error}:
      Policy.returned(settings, stop_budget(budget), key, Fail{error})
    case Done{Http.Response{+http_status, bytes}}:
      with_http_status(decoded_response(settings, budget, key, config, request, http_status, Codec.decode_utf8_with_limit(bytes, limit())), http_status)

def local_accounted(settings: Policy.Settings, key: String, value: J.JSON, counted: Core.Budget & String) -> Jev.Returned:
  match counted:
    case (+next, reason):
      Policy.returned(settings, next, key, Done{decorate(status(value), next, reason)})

def local_returned(
  settings: Policy.Settings, budget: Core.Budget, key: String,
  result: Result<&1, &1, Error, J.JSON>,
) -> Jev.Returned:
  match result:
    case Fail{error}:
      Policy.returned(settings, stop_budget(budget), key, Fail{error})
    case Done{+value}:
      local_accounted(settings, key, value, account(budget, usage_of(Wire.maybe_usage(Codec.field(value, "usage"), "input_tokens", "output_tokens"))))

def send(
  settings: Policy.Settings, budget: Core.Budget, cached: String,
  prepared: Prepared, key: String, timeout: U32,
) -> IO(Jev.Returned):
  Prepared{+config, request, body} = prepared
  Config.Settings{provider, +api, endpoint, model, key_env, auth, allow_local} = config
  match api:
    case "llama-cpp":
      do IO<Jev.Returned>:
        result : Result<&1, &1, Error, J.JSON> <- Local.evaluate(request, provider, model, endpoint, key, timeout, allow_local)
        return local_returned(settings, budget, cached, result)
    case other:
      do IO<Jev.Returned>:
        response : Result<&1, &1, Error, Http.Response> <- Http.exchange(endpoint, key, body, timeout, allow_local, auth)
        return received(settings, budget, cached, config, request, response)

def before_dispatch(settings: Policy.Settings, original: Core.Budget, reservation: Core.Budget, cached: String, prepared: Prepared, key: String, left: U32, expired: Bool) -> IO(Jev.Returned):
  match expired:
    case True{}:
      IO.pure(Jev.Returned, Policy.returned(settings, original, cached, Fail{(124, "decision deadline expired before dispatch")}))
    case False{}:
      send(settings, reservation, cached, prepared, key, left)

def authenticated(
  +settings: Policy.Settings, original: Core.Budget, reservation: Core.Budget, cached: String,
  prepared: Prepared, started: Nat, credential: Result<&1, &1, Error, String>,
) -> IO(Jev.Returned):
  match credential:
    case Fail{error}:
      IO.pure(Jev.Returned, Policy.returned(settings, original, cached, Fail{error}))
    case Done{key}:
      do IO<Jev.Returned>:
        now : Nat <- IO.now()
        +elapsed : Nat = Nat.sub(now, started)
        +timeout : Nat = U32.to_nat(Policy.timeout(settings))
        before_dispatch(settings, original, reservation, cached, prepared, key, U32.from_nat(Nat.sub(timeout, elapsed)), Nat.is_ge(elapsed, timeout))

def resolve_key(key: String, command: String, timeout: U32, anonymous: Bool) -> IO(Result<&1, &1, Error, String>):
  match anonymous:
    case True{}:
      IO.pure(Result<&1, &1, Error, String>, Done{""})
    case False{}:
      Credentials.resolve(key, command, timeout)

def credential_alias(primary_name: String, alias_name: String) -> IO(String):
  do IO<String>:
    +primary : String <- Jev.env(primary_name)
    alias : String <- Jev.env(alias_name)
    return Policy.pick_model(primary, alias, String.is_empty(primary))

def google_credential(name: String, yes: Bool) -> IO(String):
  match yes:
    case True{}: credential_alias("GEMINI_API_KEY", "GOOGLE_API_KEY")
    case False{}: Jev.env(name)

def cloudflare_credential(+name: String, yes: Bool) -> IO(String):
  match yes:
    case True{}: credential_alias("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY")
    case False{}: google_credential(name, String.eq(name, "GEMINI_API_KEY"))

def credential_env(+name: String) -> IO(String):
  cloudflare_credential(name, String.eq(name, "CLOUDFLARE_API_TOKEN"))

def credential_run(settings: Policy.Settings, original: Core.Budget, cached: String, +prepared: Prepared, +credential: String, next: Core.Budget, started: Nat, left: U32) -> IO(Jev.Returned):
  Prepared{Config.Settings{provider, api, endpoint, model, key_env, auth, local}, request, body} = prepared
  do IO<Jev.Returned>:
    inherited : String <- credential_env(key_env)
    +command : String <- Jev.env("DECISION_CREDENTIAL_COMMAND")
    +key : String = Policy.pick_model(credential, inherited, String.is_empty(credential))
    result : Result<&1, &1, Error, String> <- resolve_key(key, command, left, local && String.eq(auth, "bearer") && HttpPolicy.is_local(endpoint) && String.is_empty(key) && String.is_empty(command))
    authenticated(settings, original, next, cached, prepared, started, result)

def credential_window(settings: Policy.Settings, original: Core.Budget, cached: String, prepared: Prepared, credential: String, next: Core.Budget, started: Nat, left: U32, expired: Bool) -> IO(Jev.Returned):
  match expired:
    case True{}:
      IO.pure(Jev.Returned, Policy.returned(settings, original, cached, Fail{(124, "decision deadline expired before credentials")}))
    case False{}:
      credential_run(settings, original, cached, prepared, credential, next, started, left)

def resolve_reserved(+settings: Policy.Settings, original: Core.Budget, cached: String, prepared: Prepared, credential: String, next: Core.Budget, +started: Nat) -> IO(Jev.Returned):
  do IO<Jev.Returned>:
    now : Nat <- IO.now()
    +elapsed : Nat = Nat.sub(now, started)
    +timeout : Nat = U32.to_nat(Policy.timeout(settings))
    credential_window(settings, original, cached, prepared, credential, next, started, U32.from_nat(Nat.sub(timeout, elapsed)), Nat.is_ge(elapsed, timeout))

def reserved(
  +settings: Policy.Settings, original: Core.Budget, cached: String,
  +prepared: Prepared, +credential: String, started: Nat, reservation: Maybe<&2, Core.Budget>,
) -> IO(Jev.Returned):
  match reservation:
    case None{}:
      IO.pure(Jev.Returned, Policy.returned(settings, original, cached, Fail{(1, "decision budget exhausted")}))
    case Some{next}:
      resolve_reserved(settings, original, cached, prepared, credential, next, started)

def prepared(client: Jev.Client, credential: String, started: Nat, result: Result<&1, &1, Error, Prepared>) -> IO(Jev.Returned):
  Policy.Client{settings, +budget, key} = client
  match result:
    case Fail{error}:
      IO.pure(Jev.Returned, Policy.returned(settings, budget, key, Fail{error}))
    case Done{ready}:
      reserved(settings, budget, key, ready, credential, started, Core.reserve(budget))

def target_prepared(value: Result<&1, &1, Error, Targets.PreparedTarget>) -> Result<&1, &1, Error, Prepared>:
  match value:
    case Fail{error}: Fail{error}
    case Done{Targets.PreparedTarget{config, request, body, profile}}:
      Done{Prepared{config, request, body}}

def evaluate(client: Jev.Client, request_json: String, credential: String) -> IO(Jev.Returned):
  do IO<Jev.Returned>:
    started : Nat <- IO.now()
    resolved : Result<&1, &1, Error, Targets.PreparedTarget> <- Targets.resolve(request_json)
    prepared(client, credential, started, target_prepared(resolved))

def scoped(+settings: Policy.Settings, budget: Core.Budget, key: String, request_json: String, credential: String, ms: U32, expired: Bool) -> IO(Jev.Returned):
  match expired:
    case True{}:
      IO.pure(Jev.Returned, Policy.returned(settings, budget, key, Fail{(124, "scope deadline expired before decision")}))
    case False{}:
      do IO<Jev.Returned>:
        result : Jev.Returned <- evaluate(Policy.Client{Scope.settings_timeout(settings, ms), budget, key}, request_json, credential)
        return Scope.restored(result, settings)

def evaluate_for(scope: Scope.Budget, client: Jev.Client, request_json: String, credential: String, cap: U32) -> IO(Jev.Returned):
  Policy.Client{+settings, budget, key} = client
  do IO<Jev.Returned>:
    +ms : U32 <- Scope.remaining(scope, U32.min(cap, Policy.timeout(settings)))
    scoped(settings, budget, key, request_json, credential, ms, U32.is_eq(ms, 0))
