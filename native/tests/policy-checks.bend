import Base
import ./core.bend as Core
import ./policy-core.bend as Policy
import ./time-core.bend as Time

# One compiled ABI smoke for the checked pure policies. Universal laws remain
# separate proof roots; parser, floating-point and narrowing cases stay here.
def main() -> IO(Unit):
  do IO<Unit>:
    Core.main()
    Policy.main()
    Time.main()
