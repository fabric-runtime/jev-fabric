import Base
import ../DecisionTargets.bend as Targets

def output(result: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match result:
    case Done{text}: IO.print(text)
    case Fail{(code, message)}: IO.die(Unit, code, message)

def run(args: List<String>) -> IO(Unit):
  match args:
    case [mode, text]:
      do IO<Unit>:
        result : Result<&1, &1, U32 & String, String> <- Targets.offline(text)
        output(result)
    case other: IO.die(Unit, 2, "expected resolve request")

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    run(List.drop(&1, String, args, 1n))
