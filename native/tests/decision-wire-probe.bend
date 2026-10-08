import Base
import ../Codec.bend as Codec
import ../DecisionWire.bend as D
import ../vendor/strict-json/json.bend as J

def print_result(value: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match value:
    case Done{text}: IO.print(text)
    case Fail{(code, message)}:
      IO.die(Unit, 1, "rejected: " ++ message)

def encoded(value: Result<&1, &1, U32 & String, J.JSON>) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    v : J.JSON <- value
    Codec.encode_with_limit(v, D.bytes_max())

def reply(request: String, text: String, api: String, model: String) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    req : J.JSON <- D.request(request)
    encoded(D.reply(text, req, "fixture", api, model))

def body(request: String, api: String, model: String) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    req : J.JSON <- D.request(request)
    D.body(req, api, model)

def count_text(counts: Maybe<&1, Nat & Nat>) -> String:
  match counts:
    case None{}: "null"
    case Some{pair}:
      (i, o) = pair
      "[" ++ Nat.show(i) ++ "," ++ Nat.show(o) ++ "]"

def usage(value: Result<&1, &1, U32 & String, Maybe<&1, Nat & Nat>>) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    counts : Maybe<&1, Nat & Nat> <- value
    return count_text(counts)

def reported(text: String) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    v : J.JSON <- Codec.read_with_limit(text, D.bytes_max())
    usage(D.reported_usage(v))

def sized(n: Nat) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    v : J.JSON <- D.request("{\"state\":\"" ++ String.repeat("x", n) ++ "\",\"questions\":{\"q\":{\"type\":\"boolean\",\"instructions\":\"x\"}}}")
    return "accepted"

def maybe_number(value: Maybe<&2, Nat>) -> Result<&1, &1, U32 & String, Nat>:
  match value:
    case None{}: Fail{(22, "expected size")}
    case Some{n}: Done{n}

def number(text: String) -> Result<&1, &1, U32 & String, Nat>:
  maybe_number(Nat.read(text))

def size_text(text: String) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    n : Nat <- number(text)
    sized(n)

def copies(n: Nat, +image: J.JSON) -> List<&2, J.JSON>:
  match n:
    case 0n: Nil{}
    case 1n+rest: Con{image, copies(rest, image)}

def cloudflare_size(groups: String, suffix: String, count: String) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    n : Nat <- number(groups)
    count : Nat <- number(count)
    image : J.JSON = J.Obj{[J.Member{"mimeType", J.Str{"image/png"}}, J.Member{"data", J.Str{String.repeat("AAAA", n) ++ suffix}}]}
    rows : List<&2, J.JSON> <- D.cloudflare_image_rows(copies(count, image), 8388608n)
    return "accepted"

def reply_size(size: String) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    n : Nat <- number(size)
    req : J.JSON <- D.request("{\"state\":{},\"questions\":{\"q\":{\"type\":\"boolean\",\"instructions\":\"x\"}}}")
    raw : String = "{\"answers\":{\"q\":{\"type\":\"boolean\",\"probability\":0.5}},\"metadata\":\"" ++ String.repeat("x", n) ++ "\"}"
    v : J.JSON <- D.reply(raw, req, "fixture", "system-one", "m")
    return "accepted"

def usage_error() -> IO(Unit):
  IO.die(Unit, 2, "invalid probe arguments")

def run_request(args: List<String>) -> IO(Unit):
  match args:
    case [text]: print_result(encoded(D.request(text)))
    case other: usage_error()

def run_reply(args: List<String>) -> IO(Unit):
  match args:
    case [request, text, api, model]: print_result(reply(request, text, api, model))
    case other: usage_error()

def run_body(args: List<String>) -> IO(Unit):
  match args:
    case [request, api, model]: print_result(body(request, api, model))
    case other: usage_error()

def run_raw_usage(args: List<String>) -> IO(Unit):
  match args:
    case [text, api]: print_result(usage(D.raw_usage(text, api)))
    case other: usage_error()

def run_reported(args: List<String>) -> IO(Unit):
  match args:
    case [text]: print_result(reported(text))
    case other: usage_error()

def run_cloudflare_size(args: List<String>) -> IO(Unit):
  match args:
    case [groups, suffix, count]: print_result(cloudflare_size(groups, suffix, count))
    case other: usage_error()

def run_base64_size(args: List<String>) -> IO(Unit):
  match args:
    case [text]: IO.print(Nat.show(D.decoded_bytes(text)))
    case other: usage_error()

def run_size(args: List<String>) -> IO(Unit):
  match args:
    case [text]: print_result(size_text(text))
    case other: usage_error()

def run_reply_size(args: List<String>) -> IO(Unit):
  match args:
    case [text]: print_result(reply_size(text))
    case other: usage_error()

def run_mode_tag(mode: String, args: List<String>, tag: U32) -> IO(Unit):
  match tag:
    case 1: run_request(args)
    case 2: run_reply(args)
    case 3: run_body(args)
    case 4: run_raw_usage(args)
    case 5: run_reported(args)
    case 6: run_cloudflare_size(args)
    case 7: run_base64_size(args)
    case 8: run_size(args)
    case 9: run_reply_size(args)
    case unmatched: usage_error()

def run_mode(+mode: String, args: List<String>) -> IO(Unit):
  run_mode_tag(mode, args, Bool.pick(U32, String.eq(mode, "request"), 1, Bool.pick(U32, String.eq(mode, "reply"), 2, Bool.pick(U32, String.eq(mode, "body"), 3, Bool.pick(U32, String.eq(mode, "raw_usage"), 4, Bool.pick(U32, String.eq(mode, "reported_usage"), 5, Bool.pick(U32, String.eq(mode, "cloudflare-size"), 6, Bool.pick(U32, String.eq(mode, "base64-size"), 7, Bool.pick(U32, String.eq(mode, "size"), 8, Bool.pick(U32, String.eq(mode, "reply-size"), 9, 0))))))))))

def run(args: List<String>) -> IO(Unit):
  match args:
    case Con{mode, rest}: run_mode(mode, rest)
    case other: usage_error()

def main() -> IO(Unit):
  do IO<Unit>:
    invoked : List<String> <- IO.args
    run(List.drop(&1, String, invoked, 1n))
