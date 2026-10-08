import Base
import ../Codec.bend as Codec
import ../DecisionConfig.bend as C
import ../vendor/strict-json/json.bend as J

# Runtime input avoids huge constant-specialization in Bend's native backend.
def resolve(text: String, provider: String, model: String, endpoint: String, account: String) -> Result<&1, &1, U32 & String, C.Settings>:
  do Result<&1, &1, U32 & String, C.Settings>:
    value : J.JSON <- Codec.read_with_limit(text, 16777216)
    C.resolve(value, provider, model, endpoint, account)

def print_json(result: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match result:
    case Done{text}: IO.print(text)
    case Fail{(code, message)}: IO.die(Unit, code, message)

def show(result: Result<&1, &1, U32 & String, C.Settings>) -> IO(Unit):
  match result:
    case Fail{(code, message)}:
      IO.print("error:" ++ U32.show(code) ++ ":" ++ message)
    case Done{C.Settings{provider, api, endpoint, model, key_env, auth, allow_local}}:
      print_json(Codec.encode(J.Obj{[
        J.Member{"provider", J.Str{provider}}, J.Member{"api", J.Str{api}},
        J.Member{"endpoint", J.Str{endpoint}}, J.Member{"model", J.Str{model}},
        J.Member{"key_env", J.Str{key_env}}, J.Member{"auth", J.Str{auth}},
        J.Member{"allow_local", J.Boolean{allow_local}}
      ]}))

def dispatch(args: List<String>) -> IO(Unit):
  match args:
    case Con{"providers", Nil{}}:
      print_json(Codec.encode(C.providers()))
    case Con{text, Con{provider, Con{model, Con{endpoint, Con{account, Nil{}}}}}}:
      show(resolve(text, provider, model, endpoint, account))
    case other:
      IO.die(Unit, 2, "expected request provider_env model_env endpoint_env account, or providers")

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    dispatch(List.drop(&1, String, args, 1n))
