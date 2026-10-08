import Base
import ./Codec.bend as Codec
import ./Wire.bend as W
import ./DecisionWire.bend as Wire
import ./DecisionConfig.bend as Config
import ./DecisionHttpCore.bend as Http
import ./vendor/strict-json/json.bend as J

# Explicit, bounded configuration only. Profiles never contain credentials.
def Error() -> Type:
  U32 & String

type Document is Data:
  Document{profiles: List<&2, J.JSON>, default: String}

type Selected is Data:
  Selected{request: J.JSON, profile: String}

def present(value: Maybe<&2, J.JSON>) -> Bool:
  match value:
    case None{}: False{}
    case Some{v}: True{}

def name(+text: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    Codec.guard(Wire.profile_name(text), "Invalid decision profile name")
    return text

def selector(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, String>:
  match value:
    case None{}: Done{""}
    case Some{J.Str{s}}: name(s)
    case other: Fail{(22, "Decision profile must be a string")}

def key_chars(text: String) -> String:
  match text:
    case SNil{}: SNil{}
    case SCon{+c, rest}:
      +n = Char.to_u32(c)
      +tail = key_chars(rest)
      Bool.pick(String, (U32.is_ge(n, 97) && U32.is_le(n, 122)) || (U32.is_ge(n, 48) && U32.is_le(n, 57)), SCon{c, tail}, tail)

def secret_key(text: String) -> Bool:
  +key = key_chars(String.to_lower(text))
  String.contains(key, "secret") || String.contains(key, "password") ||
    String.contains(key, "credential") || String.contains(key, "apikey") ||
    String.contains(key, "authorization") ||
    Codec.contains(["auth", "headers", "token", "accesstoken", "refreshtoken", "privatekey"], key)

# JSON worklist bounded by the same structural job ceiling as Codec.
def secret_free(fuel: Nat, work: List<&2, J.JSON>) -> Bool:
  match fuel work:
    case _ Nil{}: True{}
    case 0n _: False{}
    case 1n+n Con{J.Member{key, value}, rest}:
      Bool.not(secret_key(key)) && secret_free(n, Con{value, rest})
    case 1n+n Con{J.Obj{fields}, rest}:
      secret_free(n, List.append(&2, J.JSON, fields, rest))
    case 1n+n Con{J.Arr{items}, rest}:
      secret_free(n, List.append(&2, J.JSON, items, rest))
    case 1n+n Con{value, rest}: secret_free(n, rest)

def endpoint(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Str{text}}:
      Codec.guard(Http.url_valid(text, True{}), "Invalid decision target endpoint; credentials and URL query options are forbidden")
    case other: Fail{(22, "Decision endpoint must be a string")}

# Structural enum only; provider/API compatibility belongs to selected preflight.
def api(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Str{text}}:
      Codec.guard(Codec.contains(["system-one", "cloudflare", "openai-decisions", "vercel-evaluate", "llama-cpp", "llama-system-one", "anthropic", "google"], text), "Invalid decision target API")
    case other: Fail{(22, "Decision API must be a known API string")}

def model(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  Wire.optional_model(value)

def target(+value: J.JSON) -> Result<&1, &1, Error, Unit>:
  do Result<&1, &1, Error, Unit>:
    Codec.guard(secret_free(32768n, [value]), "Decision targets must not contain credential or secret fields")
    fields : List<&2, J.JSON> <- W.object(value)
    Codec.guard(W.only(fields, ["provider", "api", "model", "endpoint", "allowLocal", "allowGenerated", "providerOptions", "temperature"]), "Unknown decision target field")
    raw : J.JSON <- W.need(value, "provider")
    provider : String <- W.string(raw)
    settings : Config.Settings <- Config.preset(Config.canonical(provider))
    Wire.optional_string(Codec.field(value, "provider"), 128n)
    api(Codec.field(value, "api"))
    model(Codec.field(value, "model"))
    Wire.optional_string(Codec.field(value, "endpoint"), 4096n)
    endpoint(Codec.field(value, "endpoint"))
    Wire.optional_bool(Codec.field(value, "allowLocal"))
    Wire.optional_bool(Codec.field(value, "allowGenerated"))
    Wire.options(Codec.field(value, "providerOptions"))
    Wire.optional_temperature(Codec.field(value, "temperature"))

def targets(fields: List<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match fields:
    case Nil{}: Done{Unit{}}
    case Con{J.Member{key, value}, rest}:
      do Result<&1, &1, Error, Unit>:
        valid : String <- name(key)
        target(value)
        targets(rest)
    case other: Fail{(22, "Invalid decision profiles")}

def document(+value: J.JSON) -> Result<&1, &1, Error, Document>:
  do Result<&1, &1, Error, Document>:
    fields : List<&2, J.JSON> <- W.object(value)
    Codec.guard(W.only(fields, ["version", "defaultProfile", "profiles"]), "Unknown decision profiles document field")
    version : J.JSON <- W.need(value, "version")
    v : Nat <- W.scalar(version, 0n, 1n)
    Codec.guard(Nat.is_eq(v, 1n), "Decision profiles version must be 1")
    profiles : J.JSON <- W.need(value, "profiles")
    +entries : List<&2, J.JSON> <- W.object(profiles)
    Codec.guard(Nat.is_le(List.length(&2, J.JSON, entries), 128n), "Too many decision profiles")
    targets(entries)
    +default : String <- selector(Codec.field(value, "defaultProfile"))
    Codec.guard(String.is_empty(default) || present(Codec.find_field(entries, default)), "Unknown default decision profile")
    return Document{entries, default}

def read(text: String) -> Result<&1, &1, Error, Document>:
  match text:
    case SNil{}: Done{Document{Nil{}, ""}}
    case other:
      do Result<&1, &1, Error, Document>:
        value : J.JSON <- Codec.read_with_limit(other, 65536)
        document(value)

# Whole-field overlay: providerOptions is replaced, never recursively merged.
def missing(fields: List<&2, J.JSON>, +overrides: J.JSON) -> List<&2, J.JSON>:
  match fields:
    case Nil{}: Nil{}
    case Con{J.Member{+key, value}, rest}:
      +tail = missing(rest, overrides)
      Bool.pick(List<&2, J.JSON>, present(Codec.field(overrides, key)), tail, Con{J.Member{key, value}, tail})
    case Con{other, rest}: missing(rest, overrides)

def merge(base: J.JSON, +overrides: J.JSON) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    fields : List<&2, J.JSON> <- W.object(base)
    extra : List<&2, J.JSON> <- W.object(overrides)
    return J.Obj{List.append(&2, J.JSON, missing(fields, overrides), extra)}

def remove(fields: List<&2, J.JSON>, +key: String) -> List<&2, J.JSON>:
  match fields:
    case Nil{}: Nil{}
    case Con{J.Member{+k, value}, rest}:
      +tail = remove(rest, key)
      Bool.pick(List<&2, J.JSON>, String.eq(k, key), tail, Con{J.Member{k, value}, tail})
    case Con{other, rest}: Con{other, remove(rest, key)}

def compatible(value: Maybe<&2, J.JSON>, provider: String) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Str{s}}:
      Codec.guard(String.eq(Config.canonical(s), Config.canonical(provider)), "Decision profile conflicts with explicit provider")
    case other: Fail{(22, "Decision provider must be a string")}

def selected(+request: J.JSON, +profile: String, entries: List<&2, J.JSON>, empty: Bool) -> Result<&1, &1, Error, Selected>:
  match empty:
    case True{}: Done{Selected{request, ""}}
    case False{}:
      do Result<&1, &1, Error, Selected>:
        valid : String <- name(profile)
        +target : J.JSON <- W.need(J.Obj{entries}, profile)
        raw : J.JSON <- W.need(target, "provider")
        provider : String <- W.string(raw)
        compatible(Codec.field(request, "provider"), provider)
        merged : J.JSON <- merge(target, request)
        return Selected{merged, profile}

# Selection policy after structural validation; kept separate for universal laws.
def choose_profile(explicit: String, provider: Maybe<&2, J.JSON>, ambient: String, default: String) -> String:
  Config.fallback(explicit, Bool.pick(String, present(provider), "", Config.fallback(ambient, default)))

def apply_document(+request: J.JSON, doc: Document, ambient: String) -> Result<&1, &1, Error, Selected>:
  match doc:
    case Document{entries, default}:
      do Result<&1, &1, Error, Selected>:
        fields : List<&2, J.JSON> <- W.object(request)
        explicit : String <- selector(Codec.field(request, "profile"))
        +profile : String = choose_profile(explicit, Codec.field(request, "provider"), ambient, default)
        selected(J.Obj{remove(fields, "profile")}, profile, entries, String.is_empty(profile))

def apply(request: J.JSON, text: String, ambient: String) -> Result<&1, &1, Error, Selected>:
  do Result<&1, &1, Error, Selected>:
    doc : Document <- read(text)
    apply_document(request, doc, ambient)
