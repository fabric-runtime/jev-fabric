import Base
import ./vendor/strict-json/json.bend as J

def Value() -> Data:
  J.JSON

def guard(ok: Bool, message: String) -> Result<&1, &1, U32 & String, Unit>:
  match ok:
    case True{}:
      Done{Unit{}}
    case False{}:
      Fail{(22, message)}

# Limits shared by the textual scan and the AST validator.
def bytes_max() -> U32:
  1048576

def depth_max() -> U32:
  64

def work_max() -> U32:
  32768

def one_if(flag: Bool) -> U32:
  Bool.pick(U32, flag, 1, 0)

# UTF-8 encoded width of a scalar: 1 byte, plus one per threshold it reaches.
def width(+code: U32) -> U32:
  second = one_if(U32.is_ge(code, 128))
  third = one_if(U32.is_ge(code, 2048))
  fourth = one_if(U32.is_ge(code, 65536))
  (1 + second + third + fourth : U32)

# Count bytes with a decreasing budget, rejecting invalid scalars before consumers.
def string_cost(s: String, +budget: U32) -> Result<&1, &1, U32 & String, U32>:
  match s:
    case SNil{}:
      Done{budget}
    case SCon{Chr{+code}, tail}:
      do Result<&1, &1, U32 & String, U32>:
        +bytes : U32 = width(code)
        guard(J.JSON.is_scalar(code) && U32.is_ge(budget, bytes), "JSON string/byte limit")
        string_cost(tail, U32.sub(budget, bytes))

type Scan is Data:
  Scan{quoted: Bool, escaped: Bool, depth: U32, work: U32}

def scan_step(state: Scan, +c: Char) -> Scan:
  match state:
    case Scan{True{}, True{}, depth, work}:
      Scan{True{}, False{}, depth, work}
    case Scan{True{}, False{}, depth, work}:
      Scan{Bool.not(J.JSON.is_quote(c)), J.JSON.is_slash(c), depth, work}
    case Scan{False{}, escaped, depth, work}:
      opened = one_if(J.JSON.is_lbrk(c) || J.JSON.is_lbra(c))
      closed = one_if(J.JSON.is_rbrk(c) || J.JSON.is_rbra(c))
      counted = one_if(Bool.not(J.JSON.is_ws(c)))
      Scan{
        J.JSON.is_quote(c),
        False{},
        U32.sub(U32.add(depth, opened), closed),
        U32.add(work, counted),
      }

def scan_ok(state: Scan) -> Bool:
  match state:
    case Scan{quoted, escaped, depth, work}:
      U32.is_le(depth, depth_max()) && U32.is_le(work, work_max())

# High-work profiles count structural events, not every digit in each floating
# lexeme. Bytes cap lexical work; valid() still caps nodes and numeric length.
# The normal 32768 profile uses the original scanner without any change.
def scan_profile_step(state: Scan, +c: Char, wide: Bool) -> Scan:
  match state wide:
    case Scan{False{}, escaped, depth, work} True{}:
      opened = one_if(J.JSON.is_lbrk(c) || J.JSON.is_lbra(c))
      closed = one_if(J.JSON.is_rbrk(c) || J.JSON.is_rbra(c))
      counted = one_if(J.JSON.is_quote(c) || J.JSON.is_comma(c) || J.JSON.is_colon(c) ||
        J.JSON.is_lbrk(c) || J.JSON.is_lbra(c) || J.JSON.is_rbrk(c) || J.JSON.is_rbra(c))
      Scan{J.JSON.is_quote(c), False{}, U32.sub(U32.add(depth, opened), closed), U32.add(work, counted)}
    case other flag:
      scan_step(other, c)

def scan_profile_ok(state: Scan, limit: U32) -> Bool:
  match state:
    case Scan{quoted, escaped, depth, work}:
      U32.is_le(depth, depth_max()) && U32.is_le(work, limit)

def scan_profile(s: String, state: Scan, +bytes: U32, +work: U32, +error: String) -> Result<&1, &1, U32 & String, Unit>:
  match s:
    case SNil{}:
      Done{Unit{}}
    case SCon{+c, rest}:
      do Result<&1, &1, U32 & String, Unit>:
        +code : U32 = Char.to_u32(c)
        +size : U32 = width(code)
        guard(J.JSON.is_scalar(code), "invalid Unicode scalar")
        guard(U32.is_ge(bytes, size), error)
        +next : Scan = scan_profile_step(state, c, U32.is_gt(work, work_max()))
        guard(scan_profile_ok(next, work), "JSON depth/work limit")
        scan_profile(rest, next, U32.sub(bytes, size), work, error)

def scan_with_error(s: String, state: Scan, bytes: U32, error: String) -> Result<&1, &1, U32 & String, Unit>:
  scan_profile(s, state, bytes, work_max(), error)

def scan(s: String, state: Scan, bytes: U32) -> Result<&1, &1, U32 & String, Unit>:
  scan_with_error(s, state, bytes, "JSON exceeds 1 MiB")

def contains(keys: List<&2, String>, +key: String) -> Bool:
  match keys:
    case Nil{}:
      False{}
    case Con{head, tail}:
      String.eq(head, key) || contains(tail, key)

type Job is Data:
  Val{value: J.JSON, depth: U32}
  Items{items: List<&2, J.JSON>, depth: U32}
  Fields{fields: List<&2, J.JSON>, depth: U32, seen: List<&2, String>, count: U32}

# Each job consumes fuel. Text and key-comparison work have independent budgets.
def number_matches(parsed: J.JSON, lex: String) -> Result<&1, &1, U32 & String, Unit>:
  match parsed:
    case J.Num{raw}:
      guard(String.eq(lex, raw), "invalid number lexeme")
    case other:
      Fail{(22, "invalid number lexeme")}

def valid(
  fuel: Nat,
  jobs: List<&2, Job>,
  bytes: U32,
  +cost: U32,
) -> Result<&1, &1, U32 & String, Unit>:
  match fuel jobs:
    case _ Nil{}:
      Done{Unit{}}
    case 0n _:
      Fail{(22, "JSON node limit")}
    case 1n+f Con{job, rest}:
      match job:
        case Val{value, +depth}:
          match value:
            case J.Null{}:
              valid(f, rest, bytes, cost)
            case J.Boolean{b}:
              valid(f, rest, bytes, cost)
            case J.Str{s}:
              do Result<&1, &1, U32 & String, Unit>:
                left : U32 <- string_cost(s, bytes)
                valid(f, rest, left, cost)
            case J.Num{+lex}:
              do Result<&1, &1, U32 & String, Unit>:
                left : U32 <- string_cost(lex, bytes)
                guard(Nat.is_le(String.length(lex), 1024n), "JSON numeric lexeme limit")
                parsed : J.JSON <- J.JSON.read(lex)
                number_matches(parsed, lex)
                valid(f, rest, left, cost)
            case J.Arr{items}:
              do Result<&1, &1, U32 & String, Unit>:
                guard(U32.is_lt(depth, depth_max()), "JSON depth limit")
                valid(f, Con{Items{items, U32.inc(depth)}, rest}, bytes, cost)
            case J.Obj{fields}:
              do Result<&1, &1, U32 & String, Unit>:
                guard(U32.is_lt(depth, depth_max()), "JSON depth limit")
                valid(f, Con{Fields{fields, U32.inc(depth), Nil{}, 0}, rest}, bytes, cost)
            case J.Member{key, v}:
              Fail{(22, "member outside object")}
        case Items{items, +depth}:
          match items:
            case Nil{}:
              valid(f, rest, bytes, cost)
            case Con{head, tail}:
              valid(f, Con{Val{head, depth}, Con{Items{tail, depth}, rest}}, bytes, cost)
        case Fields{fields, +depth, +seen, +count}:
          match fields:
            case Nil{}:
              valid(f, rest, bytes, cost)
            case Con{J.Member{+key, value}, tail}:
              do Result<&1, &1, U32 & String, Unit>:
                left : U32 <- string_cost(key, bytes)
                +length : U32 = U32.from_nat(String.length(key))
                guard(U32.is_le(length, 256) && U32.is_lt(count, 256), "JSON key limit")
                # A duplicate check compares with every earlier key: (length+1)*(count+1).
                +charge : U32 = U32.mul(U32.inc(length), U32.inc(count))
                guard(U32.is_ge(cost, charge), "JSON key comparison limit")
                guard(Bool.not(contains(seen, key)), "duplicate JSON key")
                remaining : Job = Fields{tail, depth, Con{key, seen}, U32.inc(count)}
                valid(f, Con{Val{value, depth}, Con{remaining, rest}}, left, U32.sub(cost, charge))
            case Con{other, tail}:
              Fail{(22, "object field is not a member")}

def validate(+value: J.JSON) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    valid(32768n, [Val{value, 0}], bytes_max(), bytes_max())
    return value

def read(+text: String) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    scan(text, Scan{False{}, False{}, 0, 0}, bytes_max())
    value : J.JSON <- J.JSON.read(text)
    validate(value)

def encode(value: J.JSON) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    checked : J.JSON <- validate(value)
    +text : String <- J.JSON.write(checked)
    scan(text, Scan{False{}, False{}, 0, 0}, bytes_max())
    return text

# Large decision payloads opt in explicitly; node/depth/key work budgets do not grow.
def large_bytes_max() -> U32:
  16777216

def limit_valid(bytes: U32) -> Result<&1, &1, U32 & String, Unit>:
  guard(U32.is_le(bytes, large_bytes_max()), "JSON limit exceeds 16 MiB")

def validate_with_limit(+value: J.JSON, +bytes: U32) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    limit_valid(bytes)
    valid(32768n, [Val{value, 0}], bytes, bytes_max())
    return value

def read_with_limit(+text: String, +bytes: U32) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    limit_valid(bytes)
    scan_with_error(text, Scan{False{}, False{}, 0, 0}, bytes, "JSON byte limit")
    value : J.JSON <- J.JSON.read(text)
    validate_with_limit(value, bytes)

def encode_with_limit(value: J.JSON, +bytes: U32) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    checked : J.JSON <- validate_with_limit(value, bytes)
    +text : String <- J.JSON.write(checked)
    scan_with_error(text, Scan{False{}, False{}, 0, 0}, bytes, "JSON byte limit")
    return text

# Explicit high-work profile ONLY for local top_logprobs replies/results. It is
# never selected by a request field. Regular and byte-only APIs stay unchanged.
def profile_valid(bytes: U32, work: U32) -> Result<&1, &1, U32 & String, Unit>:
  do Result<&1, &1, U32 & String, Unit>:
    limit_valid(bytes)
    guard(U32.is_le(work, 524288), "JSON profile work exceeds 524288")

def validate_profile(+value: J.JSON, +bytes: U32, +work: U32) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    profile_valid(bytes, work)
    # A bounded linear key-comparison budget permits repeated small objects;
    # per-object field/key limits still prevent quadratic object abuse.
    valid(U32.to_nat(work), [Val{value, 0}], bytes, U32.mul(work, 32))
    return value

def read_profile(+text: String, +bytes: U32, +work: U32) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    profile_valid(bytes, work)
    scan_profile(text, Scan{False{}, False{}, 0, 0}, bytes, work, "JSON byte limit")
    value : J.JSON <- J.JSON.read(text)
    validate_profile(value, bytes, work)

def encode_profile(value: J.JSON, +bytes: U32, +work: U32) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    checked : J.JSON <- validate_profile(value, bytes, work)
    # Writer jobs include punctuation; preserve the standard 4x node-fuel ratio.
    +text : String <- J.JSON.write_with_fuel(U32.to_nat(U32.mul(work, 4)), checked)
    scan_profile(text, Scan{False{}, False{}, 0, 0}, bytes, work, "JSON byte limit")
    return text

def field_pick(found: Bool, value: J.JSON, fallback: Maybe<&2, J.JSON>) -> Maybe<&2, J.JSON>:
  match found:
    case True{}:
      Some{value}
    case False{}:
      fallback

# `found` carries the first match, so members after it are never compared.
def find_from(
  fields: List<&2, J.JSON>,
  +key: String,
  found: Maybe<&2, J.JSON>,
) -> Maybe<&2, J.JSON>:
  match fields found:
    case _ Some{value}:
      Some{value}
    case Nil{} None{}:
      None{}
    case Con{J.Member{name, value}, tail} None{}:
      find_from(tail, key, field_pick(String.eq(name, key), value, None{}))
    case Con{other, tail} None{}:
      None{}

def find_field(fields: List<&2, J.JSON>, +key: String) -> Maybe<&2, J.JSON>:
  find_from(fields, key, None{})

def field(value: J.JSON, key: String) -> Maybe<&2, J.JSON>:
  match value:
    case J.Obj{fields}:
      find_field(fields, key)
    case other:
      None{}

def text(value: J.JSON) -> Maybe<&2, String>:
  match value:
    case J.Str{s}:
      Some{s}
    case other:
      None{}

def array(value: J.JSON) -> Maybe<&2, List<&2, J.JSON>>:
  match value:
    case J.Arr{items}:
      Some{items}
    case other:
      None{}

type UTF8 is Data:
  UTF8{remaining: U32, code: U32, minimum: U32, reversed: String}

# A lead byte below 224 starts a 2-byte sequence, below 240 a 3-byte one, else 4 bytes.
# Each keeps its payload bits and the smallest scalar that sequence length may encode.
def utf8_sequence(+b: U32, two: Bool, three: Bool, reversed: String) -> UTF8:
  match two three:
    case True{} _:
      UTF8{1, U32.mod(b, 32), 128, reversed}
    case False{} True{}:
      UTF8{2, U32.mod(b, 16), 2048, reversed}
    case False{} False{}:
      UTF8{3, U32.mod(b, 8), 65536, reversed}

def utf8_lead(+b: U32, reversed: String) -> Result<&1, &1, U32 & String, UTF8>:
  do Result<&1, &1, U32 & String, UTF8>:
    guard(U32.is_ge(b, 194) && U32.is_le(b, 244), "invalid UTF-8 lead")
    return utf8_sequence(b, U32.is_lt(b, 224), U32.is_lt(b, 240), reversed)

def utf8_start(b: U32, reversed: String, ascii: Bool) -> Result<&1, &1, U32 & String, UTF8>:
  match ascii:
    case True{}:
      Done{UTF8{0, 0, 0, SCon{Chr{b}, reversed}}}
    case False{}:
      utf8_lead(b, reversed)

def utf8_continue(
  remaining: U32,
  +code: U32,
  minimum: U32,
  reversed: String,
  last: Bool,
) -> Result<&1, &1, U32 & String, UTF8>:
  match last:
    case False{}:
      Done{UTF8{remaining, code, minimum, reversed}}
    case True{}:
      do Result<&1, &1, U32 & String, UTF8>:
        guard(U32.is_ge(code, minimum) && J.JSON.is_scalar(code), "noncanonical UTF-8 scalar")
        return UTF8{0, 0, 0, SCon{Chr{code}, reversed}}

def utf8_step(state: UTF8, +b: U32) -> Result<&1, &1, U32 & String, UTF8>:
  match state:
    case UTF8{0, code, minimum, reversed}:
      utf8_start(b, reversed, U32.is_lt(b, 128))
    case UTF8{+remaining, code, minimum, reversed}:
      do Result<&1, &1, U32 & String, UTF8>:
        guard(U32.is_ge(b, 128) && U32.is_le(b, 191), "invalid UTF-8 continuation")
        extended : U32 = U32.add(U32.mul(code, 64), U32.sub(b, 128))
        utf8_continue(U32.sub(remaining, 1), extended, minimum, reversed, U32.is_eq(remaining, 1))

def utf8_with_error(fuel: Nat, bytes: List<&2, U32>, state: UTF8, +error: String) -> Result<&1, &1, U32 & String, String>:
  match fuel bytes:
    case _ Nil{}:
      match state:
        case UTF8{0, code, minimum, reversed}:
          Done{String.reverse(reversed)}
        case other:
          Fail{(22, "truncated UTF-8")}
    case 0n _:
      Fail{(22, error)}
    case 1n+f Con{b, tail}:
      do Result<&1, &1, U32 & String, String>:
        next : UTF8 <- utf8_step(state, b)
        utf8_with_error(f, tail, next, error)

def utf8(fuel: Nat, bytes: List<&2, U32>, state: UTF8) -> Result<&1, &1, U32 & String, String>:
  utf8_with_error(fuel, bytes, state, "UTF-8 exceeds 1 MiB")

def decode_utf8(bytes: List<&2, U32>) -> Result<&1, &1, U32 & String, String>:
  utf8(1048576n, bytes, UTF8{0, 0, 0, SNil{}})

def read_bytes(bytes: List<&2, U32>) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    decoded : String <- decode_utf8(bytes)
    read(decoded)

def decode_utf8_with_limit(bytes: List<&2, U32>, +limit: U32) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    limit_valid(limit)
    utf8_with_error(U32.to_nat(limit), bytes, UTF8{0, 0, 0, SNil{}}, "UTF-8 byte limit")

def read_bytes_with_limit(bytes: List<&2, U32>, +limit: U32) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    decoded : String <- decode_utf8_with_limit(bytes, limit)
    read_with_limit(decoded, limit)

def read_bytes_profile(bytes: List<&2, U32>, +limit: U32, work: U32) -> Result<&1, &1, U32 & String, J.JSON>:
  do Result<&1, &1, U32 & String, J.JSON>:
    decoded : String <- decode_utf8_with_limit(bytes, limit)
    read_profile(decoded, limit, work)
