import Base
import ../Codec.bend as C
import ../vendor/strict-json/json.bend as J

def ok(result: Result<&1, &1, U32 & String, J.JSON>) -> Bool:
  match result:
    case Done{v}:
      True{}
    case Fail{e}:
      False{}

def text_ok(result: Result<&1, &1, U32 & String, String>) -> Bool:
  match result:
    case Done{s}:
      True{}
    case Fail{e}:
      False{}

def exact(result: Result<&1, &1, U32 & String, String>, expected: String) -> Bool:
  match result:
    case Done{s}:
      String.eq(s, expected)
    case Fail{e}:
      False{}

def nested(n: Nat) -> J.JSON:
  match n:
    case 0n:
      J.Null{}
    case 1n+p:
      J.Arr{[nested(p)]}

def entries(n: Nat) -> List<&2, J.JSON>:
  match n:
    case 0n:
      Nil{}
    case 1n+p:
      Con{J.Obj{[J.Member{"token", J.Str{"x"}}, J.Member{"logprob", J.Num{"-0.123456"}}, J.Member{"bytes", J.Arr{[J.Num{"120"}]}}]}, entries(p)}

def check(tests: List<&2, Bool>, n: Nat) -> IO(Unit):
  match tests:
    case Nil{}:
      IO.print("decision codec assertions: " ++ Nat.show(n))
    case Con{True{}, tail}:
      check(tail, 1n+n)
    case Con{False{}, tail}:
      IO.die(Unit, 1, "decision codec failed at " ++ Nat.show(n))

def main() -> IO(Unit):
  check([
    ok(C.read_with_limit("null", 4)),
    Bool.not(ok(C.read_with_limit("null", 3))),
    Bool.not(ok(C.read_with_limit("null", 16777217))),
    Bool.not(ok(C.validate_with_limit(J.Null{}, 16777217))),
    Bool.not(text_ok(C.encode_with_limit(J.Null{}, 16777217))),
    exact(C.encode_with_limit(J.Num{"1.234567890123456789e-99"}, 100), "1.234567890123456789e-99"),
    exact(C.encode_with_limit(J.Str{"🙂"}, 6), "\"🙂\""),
    Bool.not(text_ok(C.encode_with_limit(J.Str{"🙂"}, 5))),
    exact(C.decode_utf8_with_limit([240, 159, 153, 130], 4), "🙂"),
    Bool.not(text_ok(C.decode_utf8_with_limit([240, 159, 153, 130], 3))),
    Bool.not(text_ok(C.decode_utf8_with_limit([], 16777217))),
    exact(C.decode_utf8_with_limit([], 0), ""),
    ok(C.read_bytes_with_limit([110, 117, 108, 108], 4)),
    Bool.not(ok(C.read_bytes_with_limit([110, 117, 108, 108], 3))),
    Bool.not(ok(C.read_bytes_with_limit([34, 192, 128, 34], 100))),
    Bool.not(ok(C.read_with_limit("{\"a\":1,\"a\":2}", 16777216))),
    Bool.not(ok(C.validate_with_limit(nested(65n), 16777216))),
    Bool.not(ok(C.validate_profile(nested(65n), 16777216, 524288))),
    Bool.not(ok(C.read_profile("null", 10, 524289))),
    Bool.not(text_ok(C.encode_profile(J.Null{}, 16777217, 524288))),
    Bool.not(ok(C.validate_profile(J.Null{}, 100, 0))),
    ok(C.read_bytes_profile([110, 117, 108, 108], 4, 524288)),
    Bool.not(ok(C.validate_with_limit(J.Arr{entries(32768n)}, 16777216))),
    ok(C.validate_profile(J.Arr{entries(32768n)}, 16777216, 524288)),
    text_ok(C.encode_profile(J.Arr{entries(32768n)}, 16777216, 524288)),
    ok(C.read_profile("[" ++ String.repeat("{\"token\":\"x\",\"logprob\":-0.123456,\"bytes\":[120]},", 32767n) ++ "{\"token\":\"x\",\"logprob\":-0.123456,\"bytes\":[120]}]", 16777216, 524288)),
    Bool.not(ok(C.read("\"" ++ String.repeat("a", 1048576n) ++ "\""))),
    ok(C.read_with_limit("\"" ++ String.repeat("a", 1048576n) ++ "\"", 1048578)),
    text_ok(C.encode_with_limit(J.Str{String.repeat("a", 1048576n)}, 1048578)),
    Bool.not(text_ok(C.encode(J.Str{String.repeat("a", 1048576n)}))),
    ok(C.read_with_limit("\"" ++ String.repeat("a", 16777214n) ++ "\"", 16777216)),
    Bool.not(ok(C.read_with_limit("\"" ++ String.repeat("a", 16777215n) ++ "\"", 16777216))),
    text_ok(C.encode_with_limit(J.Str{String.repeat("a", 16777214n)}, 16777216)),
    Bool.not(text_ok(C.encode_with_limit(J.Str{String.repeat("a", 16777215n)}, 16777216)))
  ], 0n)
