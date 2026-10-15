import Base
import ../DecisionHttp.bend as H
import ../Time.bend as Time

def show(result: H.PostResult) -> IO(Unit):
  match result:
    case Fail{(code, message)}:
      IO.print("error:" ++ U32.show(code) ++ ":" ++ message)
    case Done{bytes}:
      IO.print("ok:" ++ Nat.show(List.length(&2, U32, bytes)))

def show_exchange(result: H.Reply) -> IO(Unit):
  match result:
    case Fail{(code, message)}:
      IO.print("error:" ++ U32.show(code) ++ ":" ++ message)
    case Done{H.Response{status, bytes}}:
      IO.print("exchange:" ++ U32.show(status) ++ ":" ++ Nat.show(List.length(&2, U32, bytes)))

def extra_headers(mode: String) -> List<&2, String>:
  match mode:
    case "typesafe-headers":
      ["TypeSafe-Danger-Zone-Images: true", "TypeSafe-Danger-Zone-Long-Context: true"]
    case "foreign-header":
      ["X-Injected: 1"]
    case other:
      Nil{}

def send(url: String, key: String, body: String, timeout: U32, auth: String, raw: Bool) -> IO(Unit):
  match raw:
    case True{}:
      do IO<Unit>:
        reply : H.Reply <- H.exchange(url, key, body, timeout, True{}, auth)
        show_exchange(reply)
    case False{}:
      do IO<Unit>:
        reply : H.PostResult <- H.post(url, key, body, timeout, True{}, auth)
        show(reply)

def body_for(mode: String) -> String:
  match mode:
    case "large":
      "{\"payload\":\"" ++ String.repeat("x", 1200000n) ++ "\"}"
    case "at-boundary":
      "{\"payload\":\"" ++ String.repeat("a", 16372n) ++ "@/does-not-exist" ++ String.repeat("@", 40000n) ++ "\",\"number\":1.234567890123456789e-99}"
    case "at-stdin-boundary":
      "{\"payload\":\"" ++ String.repeat("a", 16372n) ++ "@-\"}"
    case "max-request":
      "{\"payload\":\"" ++ String.repeat("x", 16777202n) ++ "\"}"
    case "overflow-request":
      "{\"payload\":\"" ++ String.repeat("x", 16777203n) ++ "\"}"
    case other:
      "{\"payload\":\"private-body-🙂\"}"

def timeout_for(mode: String) -> U32:
  match mode:
    case "max-request":
      10000
    case "deadline":
      350
    case other:
      5000

def send_mode(url: String, key: String, body: String, auth: String, +mode: String, headers: Bool) -> IO(Unit):
  match headers:
    case True{}:
      do IO<Unit>:
        reply : H.Reply <- H.exchange_with(url, key, body, 5000, True{}, auth, extra_headers(mode))
        show_exchange(reply)
    case False{}:
      send(url, key, body, timeout_for(mode), auth, String.eq(mode, "exchange"))

def dispatch(args: List<String>) -> IO(Unit):
  match args:
    case Con{url, Con{auth, Con{+mode, Nil{}}}}:
      do IO<Unit>:
        key : String <- Time.env("DECISION_PROBE_KEY")
        body : String = body_for(mode)
        send_mode(url, key, body, auth, mode, String.eq(mode, "typesafe-headers") || String.eq(mode, "foreign-header"))
    case other:
      IO.die(Unit, 2, "expected URL auth mode")

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    dispatch(List.drop(&1, String, args, 1n))
