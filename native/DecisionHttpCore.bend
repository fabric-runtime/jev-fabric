import Base
import ./Codec.bend as Codec
import ./HttpCore.bend as Curl
import ./vendor/strict-json/json.bend as J

# Pure policy only. No environment, shell, pooled HTTP, redirects or retry.
def bytes_max() -> U32:
  16777216

def capture_limit() -> U32:
  16777220

def port(s: String, +value: U32, seen: Bool) -> Bool:
  match s:
    case SNil{}:
      seen && U32.is_ge(value, 1) && U32.is_le(value, 65535)
    case SCon{c, rest}:
      +n = Char.to_u32(c)
      Curl.digit(n) && U32.is_le(value, 6553) && port(rest, U32.add(U32.mul(value, 10), U32.sub(n, 48)), True{})

def suffix(s: String) -> Bool:
  match s:
    case SNil{}:
      True{}
    case SCon{':', rest}:
      port(rest, 0, False{})
    case other:
      False{}

def host_chars(s: String) -> Bool:
  match s:
    case SNil{}:
      True{}
    case SCon{c, rest}:
      +n = Char.to_u32(c)
      (Curl.digit(n) || (U32.is_ge(n, 65) && U32.is_le(n, 90)) ||
       (U32.is_ge(n, 97) && U32.is_le(n, 122)) || U32.is_eq(n, 45) || U32.is_eq(n, 46)) && host_chars(rest)

def host(+s: String) -> Bool:
  Bool.not(String.is_empty(s)) && host_chars(s)

def host_port(parts: List<&2, String>) -> Bool:
  match parts:
    case Con{h, Nil{}}:
      host(h)
    case Con{h, Con{p, Nil{}}}:
      host(h) && port(p, 0, False{})
    case other:
      False{}

def authority_valid(+s: String, ipv6: Bool) -> Bool:
  match ipv6:
    case True{}:
      suffix(String.drop(s, 5n))
    case False{}:
      host_port(String.split(s, ':'))

def first(parts: List<&2, String>) -> String:
  match parts:
    case Nil{}:
      ""
    case Con{h, rest}:
      h

def authority(+url: String) -> String:
  rest = Bool.pick(String, String.starts_with(url, "https://"), String.drop(url, 8n), String.drop(url, 7n))
  first(String.split(rest, '/'))

def local_authority(+s: String) -> Bool:
  (String.starts_with(s, "127.0.0.1") && suffix(String.drop(s, 9n))) ||
  (String.starts_with(s, "[::1]") && suffix(String.drop(s, 5n)))

def is_local(+url: String) -> Bool:
  (String.starts_with(url, "https://") || String.starts_with(url, "http://")) && local_authority(authority(url))

# Percent escapes are allowed in the path, never in authority. Userinfo and URL
# options are rejected rather than relying on curl's URL parser to interpret them.
def url_valid(+url: String, allow_local: Bool) -> Bool:
  +a = authority(url)
  Nat.is_le(String.length(url), 4096n) && Curl.visible(url) &&
  Bool.not(String.contains(url, "?")) && Bool.not(String.contains(url, "#")) &&
  Bool.not(String.contains(url, "\\")) &&
  authority_valid(a, String.starts_with(a, "[::1]")) &&
  (String.starts_with(url, "https://") ||
   (allow_local && String.starts_with(url, "http://") && local_authority(a)))

def auth_valid(+key: String, local: Bool, auth: String) -> Bool:
  match auth:
    case "bearer":
      Curl.key_valid(key) || (local && String.is_empty(key))
    case "anthropic":
      Curl.key_valid(key)
    case "google":
      Curl.key_valid(key)
    case "none":
      local && String.is_empty(key)
    case other:
      False{}

def bearer(key: String, empty: Bool) -> String:
  match empty:
    case True{}:
      ""
    case False{}:
      "header = " ++ Curl.quote("Authorization: Bearer " ++ key) ++ "\n"

def headers(+key: String, auth: String) -> String:
  match auth:
    case "bearer":
      bearer(key, String.is_empty(key))
    case "anthropic":
      "header = " ++ Curl.quote("x-api-key: " ++ key) ++ "\nheader = \"anthropic-version: 2023-06-01\"\n"
    case "google":
      "header = " ++ Curl.quote("x-goog-api-key: " ++ key) ++ "\n"
    case other:
      ""

# curl --json concatenates pieces without separators, but a leading @ means
# file input even inside config quotes. The body was validated as strict JSON:
# a literal @ can only occur inside a string. Escape ONLY a chunk-leading @,
# preserving every JSON value and numeric lexeme, without enabling @file/@-.
def safe_chunk(s: String) -> String:
  match s:
    case SCon{'@', rest}:
      "\\u0040" ++ rest
    case other:
      other

type Chunk is Data:
  Chunk{remaining: U32, line: String}

def chunk_budget(chunk: Chunk) -> U32:
  match chunk:
    case Chunk{remaining, line}: remaining

def chunk_text(chunk: Chunk) -> String:
  match chunk:
    case Chunk{remaining, line}: line

def chunk_line(reversed: String, +budget: U32) -> Result<&1, &1, U32 & String, Chunk>:
  do Result<&1, &1, U32 & String, Chunk>:
    +chunk : String = String.reverse(reversed)
    +extra : U32 = Bool.pick(U32, String.starts_with(chunk, "@"), 5, 0)
    Codec.guard(U32.is_ge(budget, extra), "Decision encoded request exceeds 16 MiB")
    return Chunk{U32.sub(budget, extra), "json = " ++ Curl.quote(safe_chunk(chunk)) ++ "\n"}

def join_lines(lines: List<&2, String>) -> String:
  match lines:
    case Nil{}:
      ""
    case Con{head, tail}:
      head ++ join_lines(tail)

# 16384 scalars are at most 64 KiB UTF-8 (plus a bounded config escape overhead),
# well below curl's config-line limit. Transport expansion shares the byte cap.
def body_config(s: String, left: Nat, reversed: String, lines: List<&2, String>, budget: U32) -> Result<&1, &1, U32 & String, String>:
  match s left:
    case SNil{} _:
      do Result<&1, &1, U32 & String, String>:
        chunk : Chunk <- chunk_line(reversed, budget)
        return join_lines(List.reverse(&2, String, Con{chunk_text(chunk), lines}))
    case SCon{c, tail} 0n:
      do Result<&1, &1, U32 & String, String>:
        +chunk : Chunk <- chunk_line(reversed, budget)
        body_config(tail, 16383n, SCon{c, SNil{}}, Con{chunk_text(chunk), lines}, chunk_budget(chunk))
    case SCon{c, tail} 1n+n:
      body_config(tail, n, SCon{c, reversed}, lines, budget)

def body_object(value: J.JSON) -> Result<&1, &1, U32 & String, Unit>:
  match value:
    case J.Obj{fields}:
      Done{Unit{}}
    case other:
      Fail{(22, "Decision request body must be a JSON object")}

# Fixed provider headers the request asks for (TypeSafe's opt-ins), never caller text.
def header_lines(extra: List<&2, String>) -> String:
  match extra:
    case Nil{}:
      ""
    case Con{line, tail}:
      "header = " ++ Curl.quote(line) ++ "\n" ++ header_lines(tail)

def extra_valid(extra: List<&2, String>) -> Bool:
  match extra:
    case Nil{}:
      True{}
    case Con{+line, tail}:
      Codec.contains(["TypeSafe-Danger-Zone-Images: true", "TypeSafe-Danger-Zone-Long-Context: true"], line) && extra_valid(tail)

def config(url: String, key: String, data: String, ms: U32, auth: String, extra: List<&2, String>) -> String:
  "url = " ++ Curl.quote(url) ++ "\nrequest = \"POST\"\n" ++
  "header = \"Content-Type: application/json\"\n" ++ headers(key, auth) ++ header_lines(extra) ++
  data ++ "max-time = " ++
  U32.show(U32.div(U32.add(ms, 999), 1000)) ++ "\n"

type Request is Data:
  Request{config: String, timeout: U32}

def request_with(+url: String, +key: String, +body: String, +timeout: U32, +allow_local: Bool, +auth: String, +extra: List<&2, String>) -> Result<&1, &1, U32 & String, Request>:
  do Result<&1, &1, U32 & String, Request>:
    Codec.guard(extra_valid(extra), "Invalid decision header")
    Codec.guard(url_valid(url, allow_local), "Invalid decision endpoint")
    Codec.guard(auth_valid(key, allow_local && is_local(url), auth), "Invalid decision authentication")
    Codec.guard(U32.is_ge(timeout, 1) && U32.is_le(timeout, 3600000), "Invalid decision timeout")
    checked : J.JSON <- Codec.read_with_limit(body, bytes_max())
    body_object(checked)
    left : U32 <- Codec.string_cost(body, bytes_max())
    data : String <- body_config(body, 16384n, "", [], left)
    return Request{config(url, key, data, timeout, auth, extra), timeout}

def request(+url: String, +key: String, +body: String, +timeout: U32, +allow_local: Bool, +auth: String) -> Result<&1, &1, U32 & String, Request>:
  request_with(url, key, body, timeout, allow_local, auth, Nil{})

# No caller inputs in argv. --disable must be the first curl option. Explicit
# empty proxy bypasses environment proxies; curl cannot follow any redirect.
def argv() -> List<String>:
  ["curl", "--disable", "--silent", "--show-error", "--globoff",
   "--proto", "=https,http", "--proto-redir", "=https", "--max-redirs", "0",
   "--proxy", "", "--noproxy", "*", "--connect-timeout", "10",
   "--max-filesize", "16777216", "--write-out", "\n%{http_code}", "--config", "-"]

def body_bound(bytes: List<&2, U32>, fuel: Nat) -> Bool:
  match bytes fuel:
    case Nil{} _:
      True{}
    case Con{h, t} 0n:
      False{}
    case Con{h, t} 1n+f:
      body_bound(t, f)

def http_status(+code: U32, +bytes: List<&2, U32>, ok: Bool) -> Result<&1, &1, U32 & String, List<&2, U32>>:
  match ok:
    case False{}:
      Fail{(code, "Decision HTTP " ++ U32.show(code) ++ "; no automatic retry")}
    case True{}:
      do Result<&1, &1, U32 & String, List<&2, U32>>:
        Codec.guard(body_bound(bytes, 16777216n), "Decision response exceeds 16 MiB")
        return List.reverse(&2, U32, bytes)

def digits(a: U32, b: U32, c: U32, bytes: List<&2, U32>, valid: Bool) -> Result<&1, &1, U32 & String, List<&2, U32>>:
  match valid:
    case False{}:
      Fail{(1, "Invalid decision HTTP status")}
    case True{}:
      +code = U32.add(U32.mul(U32.sub(a, 48), 100), U32.add(U32.mul(U32.sub(b, 48), 10), U32.sub(c, 48)))
      do Result<&1, &1, U32 & String, List<&2, U32>>:
        Codec.guard(U32.is_ge(code, 100) && U32.is_le(code, 599), "Invalid decision HTTP status")
        http_status(code, bytes, U32.is_ge(code, 200) && U32.is_lt(code, 300))

def status(bytes: List<&2, U32>) -> Result<&1, &1, U32 & String, List<&2, U32>>:
  match bytes:
    case Con{+c, Con{+b, Con{+a, Con{nl, rest}}}}:
      digits(a, b, c, rest, Curl.digit(a) && Curl.digit(b) && Curl.digit(c) && U32.is_eq(nl, 10))
    case other:
      Fail{(1, "Missing decision HTTP status")}

def capture_ok(bytes: List<&2, U32>, ok: Bool) -> Result<&1, &1, U32 & String, List<&2, U32>>:
  match ok:
    case True{}:
      status(List.reverse(&2, U32, bytes))
    case False{}:
      Fail{(1, "Decision transport failed, timed out, was interrupted, or exceeded its output bound")}

type Exchange is Data:
  Exchange{status: U32, bytes: List<&2, U32>}

def ExchangeResult() -> Type:
  Result<&1, &1, U32 & String, Exchange>

def exchange_digits(a: U32, b: U32, c: U32, +bytes: List<&2, U32>, valid: Bool) -> ExchangeResult:
  match valid:
    case False{}:
      Fail{(1, "Invalid decision HTTP status")}
    case True{}:
      do Result<&1, &1, U32 & String, Exchange>:
        +code : U32 = U32.add(U32.mul(U32.sub(a, 48), 100), U32.add(U32.mul(U32.sub(b, 48), 10), U32.sub(c, 48)))
        Codec.guard(U32.is_ge(code, 100) && U32.is_le(code, 599), "Invalid decision HTTP status")
        Codec.guard(body_bound(bytes, 16777216n), "Decision response exceeds 16 MiB")
        return Exchange{code, List.reverse(&2, U32, bytes)}

def exchange_status(bytes: List<&2, U32>) -> ExchangeResult:
  match bytes:
    case Con{+c, Con{+b, Con{+a, Con{nl, rest}}}}:
      exchange_digits(a, b, c, rest, Curl.digit(a) && Curl.digit(b) && Curl.digit(c) && U32.is_eq(nl, 10))
    case other:
      Fail{(1, "Missing decision HTTP status")}

def exchange_ok(bytes: List<&2, U32>, ok: Bool) -> ExchangeResult:
  match ok:
    case True{}:
      exchange_status(List.reverse(&2, U32, bytes))
    case False{}:
      Fail{(1, "Decision transport failed, timed out, was interrupted, or exceeded its output bound")}

def captured_exchange(result: Result<&1, &1, U32 & String, Curl.RawBytes>) -> ExchangeResult:
  match result:
    case Fail{error}:
      Fail{(1, "Decision transport could not start")}
    case Done{(code, (flags, (bytes, errors)))}:
      exchange_ok(bytes, U32.is_eq(code, 0) && U32.is_eq(flags, 0))

def accept_exchange(+status: U32, bytes: List<&2, U32>, ok: Bool) -> Result<&1, &1, U32 & String, List<&2, U32>>:
  match ok:
    case True{}:
      Done{bytes}
    case False{}:
      Fail{(status, "Decision HTTP " ++ U32.show(status) ++ "; no automatic retry")}

def captured(result: Result<&1, &1, U32 & String, Curl.RawBytes>) -> Result<&1, &1, U32 & String, List<&2, U32>>:
  match result:
    case Fail{error}:
      Fail{(1, "Decision transport could not start")}
    case Done{(code, (flags, (bytes, errors)))}:
      capture_ok(bytes, U32.is_eq(code, 0) && U32.is_eq(flags, 0))
