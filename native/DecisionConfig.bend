import Base
import ./vendor/strict-json/json.bend as J
import ./Codec.bend as Codec
import ./HttpCore.bend as Text
import ./DecisionHttpCore.bend as Http

# Pure configuration: the driver supplies DECISION_PROVIDER/MODEL/ENDPOINT and
# CLOUDFLARE_ACCOUNT_ID. No credential value is stored in Settings.
type Settings is Data:
  Settings{provider: String, api: String, endpoint: String, model: String, key_env: String, auth: String, allow_local: Bool}

def fallback(+value: String, other: String) -> String:
  Bool.pick(String, String.is_empty(value), other, value)

def string_option(value: Maybe<&2, J.JSON>, fallback: String) -> Result<&1, &1, U32 & String, String>:
  match value:
    case None{}:
      Done{fallback}
    case Some{J.Str{+s}}:
      do Result<&1, &1, U32 & String, String>:
        Codec.guard(Bool.not(String.is_empty(s)), "Decision option must not be empty")
        return s
    case other:
      Fail{(22, "Decision option must be a string")}

def bool_option(value: Maybe<&2, J.JSON>) -> Result<&1, &1, U32 & String, Bool>:
  match value:
    case None{}:
      Done{False{}}
    case Some{J.Boolean{b}}:
      Done{b}
    case other:
      Fail{(22, "Decision opt-in must be a boolean")}

def object_request(value: J.JSON) -> Result<&1, &1, U32 & String, Unit>:
  match value:
    case J.Obj{fields}:
      Done{Unit{}}
    case other:
      Fail{(22, "Decision request must be an object")}

def canonical(+provider: String) -> String:
  Bool.pick(String, String.eq(provider, "vercel-ai-gateway"), "vercel", provider)

def api_valid(+api: String) -> Bool:
  Codec.contains(["system-one", "cloudflare", "openai-decisions", "vercel-evaluate", "llama-cpp", "llama-system-one", "anthropic", "google"], api)

def auth_for(+api: String) -> String:
  Bool.pick(String, String.eq(api, "anthropic"), "anthropic", Bool.pick(String, String.eq(api, "google"), "google", "bearer"))

# One registry supplies both routing and discovery. String equality avoids the
# native backend's exponential expansion of long literal String match patterns.
def presets() -> List<&2, Settings>:
  [
    Settings{"typesafe", "system-one", "https://api.typesafe.ai/v1/systemone", "jev-latest", "TYPESAFE_API_KEY", "bearer", False{}},
    Settings{"subq", "system-one", "https://api.subq.ai/v1/systemone", "subq-snap-preview", "SUBQ_API_KEY", "bearer", False{}},
    Settings{"openrouter", "system-one", "https://openrouter.ai/api/v1/systemone", "~typesafe/jev-latest", "OPENROUTER_API_KEY", "bearer", False{}},
    Settings{"vercel", "system-one", "https://ai-gateway.vercel.sh/typesafe/v1/systemone", "typesafe-ai/jev", "AI_GATEWAY_API_KEY", "bearer", False{}},
    Settings{"vercel-evaluate", "vercel-evaluate", "https://ai-gateway.vercel.sh/v1/evaluate", "typesafe-ai/jev", "AI_GATEWAY_API_KEY", "bearer", False{}},
    Settings{"vercel-decisions", "openai-decisions", "https://ai-gateway.vercel.sh/v1/decisions", "openai/gpt-6-luna-decisions", "AI_GATEWAY_API_KEY", "bearer", False{}},
    Settings{"openai", "openai-decisions", "https://api.openai.com/v1/decisions", "gpt-6-luna", "OPENAI_API_KEY", "bearer", False{}},
    Settings{"cloudflare-workers-ai", "cloudflare", "", "typesafe/jev", "CLOUDFLARE_API_TOKEN", "bearer", False{}},
    Settings{"opencode", "system-one", "https://opencode.ai/zen/v1/systemone", "jev-1.13", "OPENCODE_API_KEY", "bearer", False{}},
    Settings{"llama.cpp", "llama-cpp", "http://127.0.0.1:8080", "local", "LLAMA_API_KEY", "bearer", False{}},
    Settings{"llama-system-one", "llama-system-one", "http://127.0.0.1:8080/v1/systemone", "local", "LLAMA_API_KEY", "bearer", False{}},
    Settings{"anthropic", "anthropic", "https://api.anthropic.com/v1/messages", "claude-haiku-4-5-20251001", "ANTHROPIC_API_KEY", "anthropic", False{}},
    Settings{"google", "google", "", "gemini-2.5-flash", "GEMINI_API_KEY", "google", False{}},
    Settings{"custom", "", "", "", "DECISION_API_KEY", "", False{}},
  ]

def preset_name(settings: Settings) -> String:
  match settings:
    case Settings{provider, api, endpoint, model, key, auth, local}: provider

def pick_preset(settings: Settings, other: Result<&1, &1, U32 & String, Settings>, matched: Bool) -> Result<&1, &1, U32 & String, Settings>:
  match matched:
    case True{}: Done{settings}
    case False{}: other

def find_preset(items: List<&2, Settings>, +provider: String) -> Result<&1, &1, U32 & String, Settings>:
  match items:
    case Nil{}: Fail{(22, "Unknown decision provider")}
    case Con{+settings, rest}:
      pick_preset(settings, find_preset(rest, provider), String.eq(preset_name(settings), provider))

def preset(provider: String) -> Result<&1, &1, U32 & String, Settings>:
  find_preset(presets(), provider)

# Account IDs cannot supply URL syntax. Cloudflare IDs are 32 hexadecimal chars.
def hex(s: String) -> Bool:
  match s:
    case SNil{}:
      True{}
    case SCon{c, tail}:
      +n = Char.to_u32(c)
      (Text.digit(n) || (U32.is_ge(n, 65) && U32.is_le(n, 70)) ||
       (U32.is_ge(n, 97) && U32.is_le(n, 102))) && hex(tail)

# Models are JSON text, not HTTP header values: allow Unicode scalars while
# rejecting C0 controls and DEL. Keep the schema's scalar length limit.
def model_text(value: String) -> Bool:
  match value:
    case SNil{}: True{}
    case SCon{head, tail}:
      +n = Char.to_u32(head)
      U32.is_ge(n, 32) && Bool.not(U32.is_eq(n, 127)) && model_text(tail)

def model_valid(+model: String) -> Bool:
  Bool.not(String.is_empty(model)) && Nat.is_le(String.length(model), 256n) && model_text(model)

def cloud_alias(+model: String) -> String:
  Bool.pick(String, String.eq(model, "@cf/cloudflare/clef"), "clef",
    Bool.pick(String, String.eq(model, "@cf/cloudflare/clef-flash"), "clef-flash", model))

def canonical_model(+model: String, api: String) -> String:
  Bool.pick(String, String.eq(api, "cloudflare"), cloud_alias(model), model)

def cloud_model(+model: String) -> Bool:
  String.eq(model, "clef") || String.eq(model, "clef-flash")

def cloud_endpoint(+model: String, account: String, known: Bool) -> Result<&1, &1, U32 & String, String>:
  match known:
    case True{}:
      Done{"https://api.cloudflare.com/client/v4/accounts/" ++ account ++ "/ai/run/@cf/cloudflare/" ++ model}
    case False{}:
      do Result<&1, &1, U32 & String, String>:
        Codec.guard(String.eq(model, "typesafe/jev"), "Unknown Cloudflare model requires an explicit endpoint")
        return "https://api.cloudflare.com/client/v4/accounts/" ++ account ++ "/ai/run"

def endpoint_for(endpoint: String, +model: String, +account: String, cloud: Bool, google: Bool) -> Result<&1, &1, U32 & String, String>:
  match cloud google:
    case True{} _:
      do Result<&1, &1, U32 & String, String>:
        Codec.guard(Nat.is_eq(String.length(account), 32n) && hex(account), "CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID")
        cloud_endpoint(model, account, cloud_model(model))
    case False{} True{}:
      do Result<&1, &1, U32 & String, String>:
        Codec.guard(Http.host_chars(model), "Invalid Google model path")
        return "https://generativelanguage.googleapis.com/v1beta/models/" ++ model ++ ":generateContent"
    case False{} False{}:
      Done{endpoint}

def default_endpoint(+provider: String, endpoint: String, model: String, account: String) -> Result<&1, &1, U32 & String, String>:
  endpoint_for(endpoint, model, account, String.eq(provider, "cloudflare-workers-ai"), String.eq(provider, "google"))

# Explicit endpoint overrides do not need a Cloudflare account in the environment.
def endpoint_option(override: String, provider: String, endpoint: String, model: String, account: String, empty: Bool) -> Result<&1, &1, U32 & String, String>:
  match empty:
    case True{}:
      default_endpoint(provider, endpoint, model, account)
    case False{}:
      Done{override}

def images_present(value: Maybe<&2, J.JSON>) -> Result<&1, &1, U32 & String, Bool>:
  match value:
    case None{}:
      Done{False{}}
    case Some{J.Arr{Nil{}}}:
      Done{False{}}
    case Some{J.Arr{Con{head, tail}}}:
      Done{True{}}
    case other:
      Fail{(22, "Decision images must be an array")}

# Capabilities describe implemented wire adapters, never guessed from model IDs.
# OpenRouter SystemOne has no documented image shape. llama-cpp is the local
# chat/logprob classifier, not llama-server's separate multimodal SystemOne API.
# SubQ's SystemOne documents one: https://docs.subq.ai/endpoints/decisions-api/#images
def image_capable(+provider: String, +api: String, model: String) -> Bool:
  (String.eq(api, "cloudflare") && cloud_model(model)) || String.eq(api, "llama-system-one") ||
  (String.eq(api, "system-one") && (String.eq(provider, "subq") || String.eq(provider, "typesafe"))) ||
  (String.eq(api, "openai-decisions") && Bool.not(String.eq(provider, "vercel-decisions"))) ||
  String.eq(api, "anthropic") || String.eq(api, "google")

def temperature(value: Maybe<&2, J.JSON>, +api: String) -> Result<&1, &1, U32 & String, Unit>:
  match value:
    case None{}:
      Done{Unit{}}
    case Some{J.Num{lex}}:
      Codec.guard(String.eq(api, "llama-cpp") || String.eq(api, "google"), "Temperature is unsupported by this decision transport")
    case other:
      Fail{(22, "Decision temperature must be a number")}

def provider_options(value: Maybe<&2, J.JSON>, +provider: String, +api: String) -> Result<&1, &1, U32 & String, Unit>:
  match value:
    case None{}:
      Done{Unit{}}
    case Some{J.Obj{fields}}:
      Codec.guard(String.eq(provider, "openrouter") || String.eq(provider, "vercel") || String.eq(provider, "typesafe") ||
        String.eq(provider, "vercel-evaluate") || String.eq(provider, "vercel-decisions") ||
        String.eq(api, "vercel-evaluate") || String.eq(api, "anthropic") || String.eq(api, "google") ||
        String.eq(api, "openai-decisions"), "providerOptions is unsupported by this decision transport")
    case other:
      Fail{(22, "Decision providerOptions must be an object")}

def custom_explicit(+request: J.JSON, custom: Bool) -> Result<&1, &1, U32 & String, Unit>:
  match custom:
    case False{}:
      Done{Unit{}}
    case True{}:
      do Result<&1, &1, U32 & String, Unit>:
        api : String <- string_option(Codec.field(request, "api"), "")
        model : String <- string_option(Codec.field(request, "model"), "")
        endpoint : String <- string_option(Codec.field(request, "endpoint"), "")
        Codec.guard(Bool.not(String.is_empty(api)) && Bool.not(String.is_empty(model)) &&
          Bool.not(String.is_empty(endpoint)), "custom requires explicit api, endpoint and model")

# Vercel's Decisions surface is text-only even when selected via custom routing.
def vercel_endpoint(endpoint: String) -> Bool:
  String.eq(Http.first(String.split(String.to_lower(Http.authority(endpoint)), ':')), "ai-gateway.vercel.sh")

def configure(+request: J.JSON, settings: Settings, model_env: String, endpoint_env: String, account: String) -> Result<&1, &1, U32 & String, Settings>:
  match settings:
    case Settings{+provider, +default_api, endpoint, model, key_env, auth, old_local}:
      do Result<&1, &1, U32 & String, Settings>:
        custom_explicit(request, String.eq(provider, "custom"))
        +api : String <- string_option(Codec.field(request, "api"), default_api)
        Codec.guard(api_valid(api), "Unknown decision API")
        Codec.guard(String.eq(provider, "custom") || String.eq(api, default_api), "Decision API does not match provider preset")
        raw_model : String <- string_option(Codec.field(request, "model"), fallback(model_env, model))
        +selected_model : String = canonical_model(raw_model, api)
        Codec.guard(model_valid(selected_model), "Invalid decision model")
        +override : String <- string_option(Codec.field(request, "endpoint"), endpoint_env)
        +selected_endpoint : String <- endpoint_option(override, provider, endpoint, selected_model, account, String.is_empty(override))
        +allow_local : Bool <- bool_option(Codec.field(request, "allowLocal"))
        allow_generated : Bool <- bool_option(Codec.field(request, "allowGenerated"))
        Codec.guard(Http.url_valid(selected_endpoint, allow_local), "Invalid decision endpoint; HTTP requires exact loopback and allowLocal:true")
        Codec.guard(Bool.not(String.eq(api, "llama-cpp") || String.eq(api, "llama-system-one")) || allow_local, "Local decision APIs require allowLocal:true")
        Codec.guard(Bool.not(String.eq(api, "anthropic") || String.eq(api, "google")) || allow_generated, "Generated decisions require allowGenerated:true")
        images : Bool <- images_present(Codec.field(request, "images"))
        Codec.guard(Bool.not(images) || (image_capable(provider, api, selected_model) && Bool.not(vercel_endpoint(selected_endpoint))), "Images are unsupported by this decision transport")
        temperature(Codec.field(request, "temperature"), api)
        provider_options(Codec.field(request, "providerOptions"), provider, api)
        return Settings{provider, api, selected_endpoint, selected_model, key_env, auth_for(api), allow_local}

# Explicit target switches cannot inherit ambient model or endpoint settings.
def configure_explicit(request: J.JSON, settings: Settings, model_env: String, endpoint_env: String, account: String, explicit: Maybe<&2, J.JSON>) -> Result<&1, &1, U32 & String, Settings>:
  match explicit:
    case None{}: configure(request, settings, model_env, endpoint_env, account)
    case Some{value}: configure(request, settings, "", "", account)

def resolve(+request: J.JSON, provider_env: String, model_env: String, endpoint_env: String, account: String) -> Result<&1, &1, U32 & String, Settings>:
  do Result<&1, &1, U32 & String, Settings>:
    checked : J.JSON <- Codec.validate_with_limit(request, 16777216)
    object_request(checked)
    provider : String <- string_option(Codec.field(request, "provider"), fallback(provider_env, "typesafe"))
    settings : Settings <- preset(canonical(provider))
    configure_explicit(request, settings, model_env, endpoint_env, account, Codec.field(request, "provider"))

# Pure static discovery. No environment/credential reads or live model queries.
def discovery_endpoint(+provider: String, endpoint: String, model: String) -> String:
  Bool.pick(String, String.eq(provider, "cloudflare-workers-ai"),
    "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
    Bool.pick(String, String.eq(provider, "google"),
      "https://generativelanguage.googleapis.com/v1beta/models/" ++ model ++ ":generateContent", endpoint))

def image_support(+provider: String, +api: String) -> String:
  Bool.pick(String, String.eq(provider, "custom") || String.eq(api, "cloudflare") || String.eq(api, "llama-system-one"),
    "model-dependent", Bool.pick(String, String.eq(provider, "openai") || String.eq(provider, "subq") || String.eq(provider, "typesafe") || String.eq(api, "anthropic") || String.eq(api, "google"),
      "supported", "unsupported"))

def descriptor(result: Result<&1, &1, U32 & String, Settings>) -> J.JSON:
  match result:
    case Done{Settings{+provider, +api, endpoint, +model, key_env, auth, allow_local}}:
      J.Obj{[
        J.Member{"provider", J.Str{provider}},
        J.Member{"api", J.Str{api}},
        J.Member{"defaultModel", J.Str{model}},
        J.Member{"endpoint", J.Str{discovery_endpoint(provider, endpoint, model)}},
        J.Member{"credentialEnv", J.Str{key_env}},
        J.Member{"imageSupport", J.Str{image_support(provider, api)}},
        J.Member{"generated", J.Boolean{String.eq(api, "anthropic") || String.eq(api, "google")}},
      ]}
    case Fail{error}:
      J.Null{}

def descriptors(items: List<&2, Settings>) -> List<&2, J.JSON>:
  match items:
    case Nil{}: Nil{}
    case Con{head, tail}: Con{descriptor(Done{head}), descriptors(tail)}

def providers() -> J.JSON:
  J.Arr{descriptors(presets())}
