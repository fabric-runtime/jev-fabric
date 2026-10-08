import Base
import ../Codec.bend as Codec
import ../DecisionGenerated.bend as Generated
import ../vendor/strict-json/json.bend as J

# Direct compiler fixture; no shared build, trust, transport, credentials or API.
def print_result(result: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match result:
    case Done{text}:
      IO.print(text)
    case Fail{(code, message)}:
      IO.die(Unit, 1, message)

def encoded(result: Result<&1, &1, U32 & String, J.JSON>) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    v : J.JSON <- result
    Codec.encode_with_limit(v, 16777216)

def dispatch(mode: String, api: String, v: J.JSON, model: String) -> Result<&1, &1, U32 & String, String>:
  match mode:
    case "body":
      Generated.body(v, api, model)
    case "unwrap":
      encoded(Generated.unwrap(v, api))
    case "usage":
      encoded(Generated.raw_usage(v, api))
    case other:
      Fail{(22, "invalid probe mode")}

def run_text(mode: String, api: String, text: String, model: String) -> Result<&1, &1, U32 & String, String>:
  do Result<&1, &1, U32 & String, String>:
    v : J.JSON <- Codec.read_with_limit(text, 16777216)
    dispatch(mode, api, v, model)

def file_result(pair: File & Result<&1, &1, U32 & String, String>, mode: String, api: String, model: String) -> IO(Unit):
  match pair:
    case (file, result):
      do IO<Unit>:
        File.close(file)
        text : String <- IO.try(String, IO.pure(Result<&1, &1, U32 & String, String>, result))
        print_result(run_text(mode, api, text, model))

def run_file(mode: String, api: String, path: String, model: String) -> IO(Unit):
  do IO<Unit>:
    f : File <- IO.try(File, File.open(path, "r"))
    pair : File & Result<&1, &1, U32 & String, String> <- File.read(f, 16777217)
    file_result(pair, mode, api, model)

def run(args: List<String>) -> IO(Unit):
  match args:
    case ["file", mode, api, path, model]:
      run_file(mode, api, path, model)
    case [mode, api, text, model]:
      print_result(run_text(mode, api, text, model))
    case other:
      IO.die(Unit, 2, "usage: [file] body|unwrap|usage api text|path model")

def main() -> IO(Unit):
  do IO<Unit>:
    invoked : List<String> <- IO.args
    run(List.drop(&1, String, invoked, 1n))
