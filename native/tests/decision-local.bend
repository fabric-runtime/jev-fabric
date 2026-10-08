import Base
import ../DecisionLocal.bend as Local
import ../DecisionMath.bend as Math
import ../Codec.bend as Codec
import ../Json.bend as Json
import ../vendor/strict-json/json.bend as J

# Intentionally compiled directly, without shared build/trust changes.
def show(result: Result<&1, &1, U32 & String, J.JSON>) -> IO(Unit):
  match result:
    case Fail{(code, message)}:
      IO.print("{\"dispatchError\":" ++ Json.quote(message) ++ ",\"code\":" ++ U32.show(code) ++ "}")
    case Done{value}:
      do IO<Unit>:
        text : String <- IO.pass(String, Codec.encode_profile(value, 16777216, 524288))
        IO.print(text)

def show_preflight(result: Result<&1, &1, U32 & String, Unit>) -> IO(Unit):
  match result:
    case Done{unit}:
      IO.print("ok")
    case Fail{(code, message)}:
      IO.print("error:" ++ message)

def run(text: String, timeout: String) -> IO(Unit):
  do IO<Unit>:
    request : J.JSON <- IO.pass(J.JSON, Codec.read(text))
    ms : U32 = Maybe.default(&2, U32, U32.read(timeout), 60000)
    result : Result<&1, &1, U32 & String, J.JSON> <- Local.evaluate(request, "local-test", "mock-model", "http://127.0.0.1:9999/v1///", "", ms, True{})
    show(result)

def dispatch(args: List<String>) -> IO(Unit):
  match args:
    case Con{"eval", Con{text, Con{timeout, Nil{}}}}:
      run(text, timeout)
    case Con{"preflight", Con{text, Nil{}}}:
      do IO<Unit>:
        request : J.JSON <- IO.pass(J.JSON, Codec.read(text))
        show_preflight(Local.preflight(request))
    case Con{"math", Con{temp, Con{logs, Nil{}}}}:
      do IO<Unit>:
        result : Result<&1, &1, U32 & String, String> <- Math.statistics(temp, logs)
        text : String <- IO.pass(String, result)
        IO.print(text)
    case other:
      IO.die(Unit, 2, "expected eval/preflight/math arguments")

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    dispatch(List.drop(&1, String, args, 1n))
