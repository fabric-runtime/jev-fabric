import Base
import ../DecisionCli.bend as Flags
import ../Codec.bend as Codec
import ../ServeCore.bend as Serve
import ../Input.bend as Input
import ../vendor/strict-json/json.bend as J

def output(result: Result<&1, &1, U32 & String, String>) -> IO(Unit):
  match result:
    case Done{text}: IO.print(text)
    case Fail{(code, message)}: IO.die(Unit, code, message)

def file(path: String, overrides: String) -> IO(Unit):
  do IO<Unit>:
    text : String <- IO.try(String, Input.read_limit(path, 16777216))
    output(Flags.request(text, overrides))

def time(value: Maybe<&2, U32>) -> J.JSON:
  match value:
    case None{}: J.Null{}
    case Some{ms}: J.Num{U32.show(ms)}

def parsed(command: String, value: Flags.Arguments, execute: Bool) -> IO(Unit):
  match value execute:
    case Flags.Arguments{path, tokens, timeout, overrides} True{}: file(path, overrides)
    case Flags.Arguments{path, tokens, timeout, overrides} False{}:
      output(Codec.encode(J.Obj{[
        J.Member{"command", J.Str{command}}, J.Member{"path", J.Str{path}},
        J.Member{"tokens", J.Str{tokens}}, J.Member{"timeoutMs", time(timeout)},
        J.Member{"overrides", J.Str{overrides}}
      ]}))

def cli(args: List<String>, execute: Bool) -> IO(Unit):
  match args:
    case Con{+command, rest}:
      do IO<Unit>:
        value : Flags.Arguments <- IO.pass(Flags.Arguments, Flags.parse(rest, String.eq(command, "resolve-decision")))
        parsed(command, value, execute)
    case other: IO.die(Unit, 2, "missing command")

def protocol_op(op: Serve.Op) -> IO(Unit):
  match op:
    case Serve.ResolveDecision{request}: output(Codec.encode_with_limit(request, 16777216))
    case Serve.ValidateDecision{request}: output(Serve.validated_decision(request))
    case other: IO.die(Unit, 2, "unexpected protocol operation")

def operation(fields: List<&2, J.JSON>, validate: Bool) -> Result<&1, &1, U32 & String, Serve.Op>:
  match validate:
    case True{}: Serve.validate_decision_op(fields)
    case False{}: Serve.resolve_decision_op(fields)

def protocol(args: List<String>, validate: Bool) -> IO(Unit):
  match args:
    case [text]:
      do IO<Unit>:
        value : J.JSON <- IO.pass(J.JSON, Codec.read_with_limit(text, 16777216))
        fields : List<&2, J.JSON> <- IO.pass(List<&2, J.JSON>, Serve.object(value))
        op : Serve.Op <- IO.pass(Serve.Op, operation(fields, validate))
        protocol_op(op)
    case other: IO.die(Unit, 2, "expected protocol request")

def run_tag(tag: U32, args: List<String>) -> IO(Unit):
  match tag:
    case 1: cli(args, False{})
    case 2: cli(args, True{})
    case 3: protocol(args, False{})
    case 4: IO.print(Serve.features_json())
    case 5: protocol(args, True{})
    case other: IO.die(Unit, 2, "invalid probe mode")

def run(args: List<String>) -> IO(Unit):
  match args:
    case Con{+mode, rest}:
      run_tag(Bool.pick(U32, String.eq(mode, "cli"), 1, Bool.pick(U32, String.eq(mode, "file"), 2, Bool.pick(U32, String.eq(mode, "protocol"), 3, Bool.pick(U32, String.eq(mode, "features"), 4, Bool.pick(U32, String.eq(mode, "validate"), 5, 0))))), rest)
    case other: IO.die(Unit, 2, "missing probe mode")

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    run(List.drop(&1, String, args, 1n))
