import Base
import ../DecisionHttpCore.bend as H

def request_ok(result: Result<&1, &1, U32 & String, H.Request>) -> Bool:
  match result:
    case Done{r}:
      True{}
    case Fail{e}:
      False{}

def failed(result: Result<&1, &1, U32 & String, List<&2, U32>>, code: U32, message: String) -> Bool:
  match result:
    case Fail{(c, m)}:
      U32.is_eq(c, code) && String.eq(m, message)
    case Done{b}:
      False{}

def bytes_ok(result: Result<&1, &1, U32 & String, List<&2, U32>>) -> Bool:
  match result:
    case Done{Con{0, Con{255, Nil{}}}}:
      True{}
    case other:
      False{}

def exchange_bytes(result: H.ExchangeResult, expected: U32) -> Bool:
  match result:
    case Done{H.Exchange{status, Con{0, Con{255, Nil{}}}}}:
      U32.is_eq(status, expected)
    case other:
      False{}

def chunk_rejected(result: Result<&1, &1, U32 & String, H.Chunk>) -> Bool:
  match result:
    case Fail{error}: True{}
    case Done{chunk}: False{}

def invalid(url: String) -> Bool:
  Bool.not(H.url_valid(url, True{}))

def check(tests: List<&2, Bool>, n: Nat) -> IO(Unit):
  match tests:
    case Nil{}:
      IO.print("decision HTTP policy assertions: " ++ Nat.show(n))
    case Con{True{}, tail}:
      check(tail, 1n+n)
    case Con{False{}, tail}:
      IO.die(Unit, 1, "decision HTTP policy failed at " ++ Nat.show(n))

def main() -> IO(Unit):
  check([
    H.url_valid("https://api.example.com/v1/decision", False{}),
    exchange_bytes(H.captured_exchange(Done{(0, (0, ([0, 255, 10, 52, 48, 49], [])))}), 401),
    exchange_bytes(H.captured_exchange(Done{(0, (0, ([0, 255, 10, 51, 48, 50], [])))}), 302),
    exchange_bytes(H.captured_exchange(Done{(0, (0, ([0, 255, 10, 50, 48, 48], [])))}), 200),
    Bool.not(exchange_bytes(H.captured_exchange(Done{(0, (1, ([0, 255, 10, 50, 48, 48], [])))}), 200)),
    String.eq(H.safe_chunk("@/etc/passwd"), "\\u0040/etc/passwd"),
    String.eq(H.safe_chunk("@-"), "\\u0040-"),
    chunk_rejected(H.chunk_line("@", 4)),
    Bool.not(chunk_rejected(H.chunk_line("@", 5))),
    String.eq(H.safe_chunk("@@@"), "\\u0040@@"),
    String.eq(H.safe_chunk("x@-"), "x@-"),
    String.eq(H.safe_chunk(""), ""),
    Bool.not(String.starts_with(H.safe_chunk("@anything"), "@")),
    H.url_valid("http://127.0.0.1", True{}),
    H.url_valid("http://[::1]", True{}),
    H.url_valid("http://[::1]:65535/a/b", True{}),
    H.url_valid("http://127.0.0.1:00080/a", True{}),
    H.url_valid("https://api.cloudflare.com/accounts/abc/ai/run/@cf/cloudflare/clef", False{}),
    Bool.not(H.url_valid("http://127.0.0.1", False{})),
    invalid("http://localhost:8080"),
    invalid("http://127.0.0.2"),
    invalid("http://127.1"),
    invalid("http://2130706433"),
    invalid("http://0177.0.0.1"),
    invalid("http://127.0.0.1.evil.com"),
    invalid("http://127.0.0.1@evil.com"),
    invalid("http://evil@127.0.0.1"),
    invalid("http://[::1]evil"),
    invalid("http://[::ffff:127.0.0.1]"),
    invalid("http://[::1%25lo0]"),
    invalid("http://127.0.0.1:"),
    invalid("http://127.0.0.1:0"),
    invalid("http://127.0.0.1:65536"),
    invalid("http://127.0.0.1:80x"),
    invalid("http://127.0.0.1:4294967297"),
    invalid("http://127.0.0.1/?x=1"),
    invalid("https://example.com/#frag"),
    invalid("https://user:pass@example.com/path"),
    invalid("https://%65xample.com/path"),
    invalid("https://example.com\\@evil/path"),
    invalid("https://example.com/\nheader=x"),
    invalid("ftp://example.com/file"),
    invalid("https:///path"),
    H.auth_valid("KEY", False{}, "bearer"),
    Bool.not(H.auth_valid("", False{}, "bearer")),
    H.auth_valid("", True{}, "bearer"),
    H.auth_valid("", True{}, "none"),
    Bool.not(H.auth_valid("", False{}, "none")),
    Bool.not(H.auth_valid("KEY", True{}, "none")),
    Bool.not(H.auth_valid("KEY\nInjected: x", True{}, "bearer")),
    Bool.not(H.auth_valid("", True{}, "anthropic")),
    Bool.not(H.auth_valid("", True{}, "google")),
    Bool.not(H.auth_valid("KEY", False{}, "bad")),
    String.eq(H.headers("", "bearer"), ""),
    String.contains(H.headers("KEY", "anthropic"), "x-api-key: KEY"),
    String.contains(H.headers("KEY", "anthropic"), "anthropic-version: 2023-06-01"),
    String.contains(H.headers("KEY", "google"), "x-goog-api-key: KEY"),
    Bool.not(String.contains(H.headers("KEY", "google"), "Authorization")),
    request_ok(H.request("http://127.0.0.1", "", "{}", 1, True{}, "bearer")),
    Bool.not(request_ok(H.request("https://example.com", "", "{}", 1, False{}, "bearer"))),
    Bool.not(request_ok(H.request("https://example.com", "KEY", "{}", 0, False{}, "bearer"))),
    Bool.not(request_ok(H.request("https://example.com", "KEY", "{}", 3600001, False{}, "bearer"))),
    Bool.not(request_ok(H.request("https://example.com", "KEY", "\u{0}", 10, False{}, "bearer"))),
    Bool.not(request_ok(H.request("https://example.com", "KEY", "@/etc/passwd", 10, False{}, "bearer"))),
    Bool.not(request_ok(H.request("https://example.com", "KEY", "@-", 10, False{}, "bearer"))),
    Bool.not(request_ok(H.request("https://example.com", "KEY", "[]", 10, False{}, "bearer"))),
    Bool.not(request_ok(H.request("https://example.com", "KEY", "{\"x\":1,\"x\":2}", 10, False{}, "bearer"))),
    bytes_ok(H.captured(Done{(0, (0, ([0, 255, 10, 50, 48, 48], [])))})),
    failed(H.captured(Done{(0, (0, ([83, 69, 67, 82, 69, 84, 10, 52, 48, 49], [])))}), 401, "Decision HTTP 401; no automatic retry"),
    failed(H.captured(Done{(0, (0, ([10, 51, 48, 50], [])))}), 302, "Decision HTTP 302; no automatic retry"),
    failed(H.captured(Fail{(5, "SECRET")}), 1, "Decision transport could not start"),
    failed(H.captured(Done{(7, (0, ([], [83, 69, 67, 82, 69, 84])))}), 1, "Decision transport failed, timed out, was interrupted, or exceeded its output bound"),
    failed(H.captured(Done{(0, (1, ([10, 50, 48, 48], [])))}), 1, "Decision transport failed, timed out, was interrupted, or exceeded its output bound"),
    failed(H.captured(Done{(0, (2, ([10, 50, 48, 48], [])))}), 1, "Decision transport failed, timed out, was interrupted, or exceeded its output bound"),
    failed(H.status([48, 48, 50]), 1, "Missing decision HTTP status"),
    failed(H.status([120, 48, 50, 10]), 1, "Invalid decision HTTP status")
  ], 0n)
