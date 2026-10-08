import Base
import ./TimeCore.bend as Time
import ./Codec.bend as Codec
import ./Wire.bend as W
import ./DecisionProfiles.bend as Profiles
import ./DecisionConfig.bend as Config
import ./vendor/strict-json/json.bend as J

def Error() -> Type:
  U32 & String

type Flags is Data:
  Flags{fields: List<&2, J.JSON>, timeout: Maybe<&2, U32>, pending: String, positional: List<&2, String>, literal: Bool}

type Arguments is Data:
  Arguments{path: String, tokens: String, timeout: Maybe<&2, U32>, overrides: String}

def flag(+text: String) -> String:
  Bool.pick(String, String.eq(text, "--provider"), "provider",
    Bool.pick(String, String.eq(text, "--model"), "model",
      Bool.pick(String, String.eq(text, "--profile"), "profile",
        Bool.pick(String, String.eq(text, "--api"), "api",
          Bool.pick(String, String.eq(text, "--endpoint"), "endpoint",
            Bool.pick(String, String.eq(text, "--timeout-ms"), "timeout", ""))))))

def unique(previous: Maybe<&2, U32>, value: U32) -> Result<&1, &1, Error, U32>:
  match previous:
    case None{}: Done{value}
    case Some{old}: Fail{(2, "specify the timeout only once")}

def value_field(fields: List<&2, J.JSON>, timeout: Maybe<&2, U32>, key: String, +value: String, time: Bool) -> Result<&1, &1, Error, Flags>:
  match time:
    case True{}:
      do Result<&1, &1, Error, Flags>:
        ms : U32 <- Time.parse(value, 3600000)
        selected : U32 <- unique(timeout, ms)
        return Flags{fields, Some{selected}, "", Nil{}, False{}}
    case False{}:
      do Result<&1, &1, Error, Flags>:
        Codec.guard(Bool.not(String.is_empty(value)), "Decision flag requires a nonempty value")
        return Flags{Con{J.Member{key, J.Str{value}}, fields}, timeout, "", Nil{}, False{}}

def begin_flag(+text: String, +fields: List<&2, J.JSON>, timeout: Maybe<&2, U32>, positional: List<&2, String>, literal: Bool, option: Bool) -> Result<&1, &1, Error, Flags>:
  match option:
    case False{}: Done{Flags{fields, timeout, "", Con{text, positional}, literal}}
    case True{}:
      do Result<&1, &1, Error, Flags>:
        Codec.guard(Nat.is_eq(List.length(&2, String, positional), 0n), "Decision flags must precede the request file")
        +key : String = flag(text)
        Codec.guard(Bool.not(String.is_empty(key)) || String.eq(text, "--"), "Unknown decision flag")
        Codec.guard(Bool.not(Profiles.present(Codec.find_field(fields, key))), "Duplicate decision flag")
        return Flags{fields, timeout, key, Nil{}, String.eq(text, "--")}

def step_value(+text: String, fields: List<&2, J.JSON>, timeout: Maybe<&2, U32>, +pending: String, positional: List<&2, String>, +literal: Bool, waiting: Bool) -> Result<&1, &1, Error, Flags>:
  match waiting:
    case True{}: value_field(fields, timeout, pending, text, String.eq(pending, "timeout"))
    case False{}: begin_flag(text, fields, timeout, positional, literal, Bool.not(literal) && String.starts_with(text, "-"))

def step(text: String, state: Flags) -> Result<&1, &1, Error, Flags>:
  match state:
    case Flags{fields, timeout, +pending, positional, literal}:
      step_value(text, fields, timeout, pending, positional, literal, Bool.not(String.is_empty(pending)))

def scan(args: List<String>, state: Flags) -> Result<&1, &1, Error, Flags>:
  match args:
    case Nil{}: Done{state}
    case Con{text, rest}:
      do Result<&1, &1, Error, Flags>:
        next : Flags <- step(text, state)
        scan(rest, next)

def digits(text: String) -> Bool:
  match text:
    case SNil{}: True{}
    case SCon{c, rest}: Char.is_digit(c) && digits(rest)

def legacy(raw: String, path: String, tokens: String, timeout: Maybe<&2, U32>, overrides: String) -> Result<&1, &1, Error, Arguments>:
  do Result<&1, &1, Error, Arguments>:
    ms : U32 <- Time.parse(raw, 3600000)
    selected : U32 <- unique(timeout, ms)
    return Arguments{path, tokens, Some{selected}, overrides}

def pair(first: String, second: String, timeout: Maybe<&2, U32>, overrides: String, numeric: Bool) -> Result<&1, &1, Error, Arguments>:
  match numeric:
    case True{}: legacy(first, second, "100000", timeout, overrides)
    case False{}: Done{Arguments{first, second, timeout, overrides}}

def positionals(args: List<&2, String>, timeout: Maybe<&2, U32>, overrides: String, literal: Bool, offline: Bool) -> Result<&1, &1, Error, Arguments>:
  match args:
    case [path]: Done{Arguments{path, "100000", timeout, overrides}}
    case [+first, second]:
      do Result<&1, &1, Error, Arguments>:
        Codec.guard(Bool.not(offline), "resolve-decision requires one request file")
        pair(first, second, timeout, overrides, Bool.not(literal) && digits(first) && Bool.not(String.is_empty(first)))
    case [raw, path, tokens]:
      do Result<&1, &1, Error, Arguments>:
        Codec.guard(Bool.not(offline) && Bool.not(literal), "Unexpected decision arguments")
        legacy(raw, path, tokens, timeout, overrides)
    case other: Fail{(2, "Decision command requires a request file")}

def finish(state: Flags, offline: Bool) -> Result<&1, &1, Error, Arguments>:
  match state:
    case Flags{fields, timeout, pending, positional, literal}:
      do Result<&1, &1, Error, Arguments>:
        Codec.guard(String.is_empty(pending), "Decision flag requires a value")
        overrides : String <- Codec.encode(J.Obj{fields})
        positionals(List.reverse(&2, String, positional), timeout, overrides, literal, offline)

def parse(args: List<String>, offline: Bool) -> Result<&1, &1, Error, Arguments>:
  do Result<&1, &1, Error, Arguments>:
    state : Flags <- scan(args, Flags{Nil{}, None{}, "", Nil{}, False{}})
    finish(state, offline)

def different_provider(old: Maybe<&2, J.JSON>, next: Maybe<&2, J.JSON>) -> Bool:
  match old next:
    case Some{J.Str{a}} Some{J.Str{b}}: Bool.not(String.eq(Config.canonical(a), Config.canonical(b)))
    case _ _: False{}

def switched(value: J.JSON, switch: Bool) -> Result<&1, &1, Error, J.JSON>:
  match switch:
    case False{}: Done{value}
    case True{}:
      do Result<&1, &1, Error, J.JSON>:
        fields : List<&2, J.JSON> <- W.object(value)
        return J.Obj{Profiles.remove(fields, "providerOptions")}

# CLI values override file fields; the merged request still passes profile /
# provider conflict checks and the ordinary strict adapter preflight.
def request(text: String, overrides: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    +value : J.JSON <- Codec.read_with_limit(text, 16777216)
    +flags : J.JSON <- Codec.read(overrides)
    base : J.JSON <- switched(value, different_provider(Codec.field(value, "provider"), Codec.field(flags, "provider")))
    merged : J.JSON <- Profiles.merge(base, flags)
    Codec.encode_with_limit(merged, 16777216)
