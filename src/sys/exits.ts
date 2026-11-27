// Child exits as events: one SIGCHLD listener for the whole process,
// installed only while something waits on a child. A waiter registers before
// it spawns and calls waitpid after registering, so no exit is missed: one
// that came before its waitpid only wakes it once more (a harmless extra
// poll). SIGCHLDs coalesce, so every waiter rechecks its own pid on each one.

const waiters = new Set<() => void>()
const fire = () => {
  for (const wake of [...waiters]) wake()
}

/** Calls `wake` on every SIGCHLD until the returned function is called. */
export function onChildExit(wake: () => void): () => void {
  if (waiters.size === 0) process.on('SIGCHLD', fire)
  waiters.add(wake)
  return () => {
    if (waiters.delete(wake) && waiters.size === 0) process.off('SIGCHLD', fire)
  }
}
