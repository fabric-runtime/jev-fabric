import Base
import ./Process.bend as Process
import ./DecisionHttpCore.bend as Policy

# The original post result remains source-compatible.
def PostResult() -> Type:
  Result<&1, &1, U32 & String, List<&2, U32>>

type Response is Data:
  Response{status: U32, bytes: List<&2, U32>}

def Reply() -> Type:
  Result<&1, &1, U32 & String, Response>

def from_policy(result: Policy.ExchangeResult) -> Reply:
  match result:
    case Fail{error}:
      Fail{error}
    case Done{Policy.Exchange{status, bytes}}:
      Done{Response{status, bytes}}

# Native capture permits 16 MiB plus status and the private escaped stdin
# config. No pooled transport, fallback, automatic retry, shell or temp files.
def execute_exchange(plan: Result<&1, &1, U32 & String, Policy.Request>) -> IO(Reply):
  match plan:
    case Fail{error}:
      IO.pure(Reply, Fail{error})
    case Done{Policy.Request{config, timeout}}:
      do IO<Reply>:
        result : Result<&1, &1, U32 & String, Process.RawBytes> <- Process.capture(
          Policy.argv(), config, timeout, Policy.capture_limit()
        )
        return from_policy(Policy.captured_exchange(result))

def post_result(reply: Reply) -> PostResult:
  match reply:
    case Fail{error}:
      Fail{error}
    case Done{Response{+status, bytes}}:
      Policy.accept_exchange(status, bytes, U32.is_ge(status, 200) && U32.is_lt(status, 300))

def execute(plan: Result<&1, &1, U32 & String, Policy.Request>) -> IO(PostResult):
  do IO<PostResult>:
    reply : Reply <- execute_exchange(plan)
    return post_result(reply)

# All HTTP statuses are preserved with bounded raw bytes; only transport or
# policy failures are Fail. Redirect responses are returned, never followed.
def exchange(url: String, key: String, body: String, timeout: U32, allow_local: Bool, auth: String) -> IO(Reply):
  execute_exchange(Policy.request(url, key, body, timeout, allow_local, auth))

def exchange_with(url: String, key: String, body: String, timeout: U32, allow_local: Bool, auth: String, headers: List<&2, String>) -> IO(Reply):
  execute_exchange(Policy.request_with(url, key, body, timeout, allow_local, auth, headers))

def post(url: String, key: String, body: String, timeout: U32, allow_local: Bool, auth: String) -> IO(PostResult):
  do IO<PostResult>:
    reply : Reply <- exchange(url, key, body, timeout, allow_local, auth)
    return post_result(reply)
