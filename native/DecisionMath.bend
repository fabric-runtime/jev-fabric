import Base

# Computational FFI only: finite double softmax/statistics, no external effects.
# Base has F32 but no F64. This is a trusted foreign boundary, not a pure proof.
# Input: temperature lexeme; newline-separated label logprob lexemes (2..62).
# Empty values validates temperature only. Output: JSON with roundtrip doubles.
def Native.statistics(temperature: String, values: String) -> IO(Result<&1, &1, U32 & String, String>):
  import "./decision_math.c"

def checked(temperature: String, values: String, allowed: Bool) -> IO(Result<&1, &1, U32 & String, String>):
  match allowed:
    case False{}:
      IO.pure(Result<&1, &1, U32 & String, String>, Fail{(22, "local math input limit")})
    case True{}:
      Native.statistics(temperature, values)

def statistics(+temperature: String, +values: String) -> IO(Result<&1, &1, U32 & String, String>):
  checked(temperature, values, Nat.is_le(String.length(temperature), 1024n) && Nat.is_le(String.length(values), 63550n))
