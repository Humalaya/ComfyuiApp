// Coordinates the ONE native KeepAlive foreground service (see keepAlive.ts /
// KeepAliveService.java) across MULTIPLE generation hooks that can each have
// a job running at the same time — Video, SDXL and Krea2 are three
// independent hook instances (useComfyGeneration / useImageGeneration), each
// with its own PC-RAM-tracked job (see remoteJobStorage.ts), and any subset
// of them can be generating at once.
//
// The native service itself only ever tracks ONE poll/notify target — every
// start() call just re-points it, and stop() unconditionally tears the
// whole thing (foreground status, WiFi lock, wake lock) down. Called
// directly from three places with no coordination, that means whichever job
// finishes *first* would call stop() and rip away the "stay alive on lock"
// protection out from under the other jobs that are still running — the
// exact bug this module exists to prevent.
//
// This is a plain reference count: each hook "holds" the service open for
// as long as its own job is in flight (from generate()/recovery through
// finish/fail/reset/cancel) and the real native stop() only fires once
// every holder has released. A still-running job that isn't the
// most-recently-updated target keeps the *process/socket alive* the whole
// time regardless (that's the one shared foreground service protecting all
// of them at once) — it just won't be the one the native poller proactively
// notifies about if it finishes while backgrounded and another, later job
// is the currently-tracked target. That job's own completion is still
// picked up correctly the moment the app is foregrounded again (the PC-RAM
// + /history-poll recovery in each hook doesn't depend on this service at
// all) — it just may not get its own separate push notification.
import { startKeepAlive as nativeStart, stopKeepAlive as nativeStop } from './keepAlive'

type StartOptions = Parameters<typeof nativeStart>[0]

const holders = new Set<symbol>()

// Call once per logical generation attempt, as early as possible (right when
// generate() starts submitting, or when a job is recovered on mount) — this
// is what should determine the ref count, not how many times the target
// details get updated afterwards. Returns a token; hand it back to
// releaseKeepAlive() exactly once when this same attempt reaches a terminal
// state (done/error/reset/cancel).
export function holdKeepAlive(options?: StartOptions): symbol {
  const token = Symbol('keepAliveHolder')
  holders.add(token)
  nativeStart(options)
  return token
}

// Re-points the native service's poll/notify target at a specific job (e.g.
// once queuePrompt() resolves and a real prompt_id exists) without changing
// who's holding it open. Safe to call even for a holder that isn't "most
// recent" — it just won't stick as the tracked target once a later update
// (from this or another holder) comes in.
export function updateKeepAlive(options?: StartOptions): void {
  nativeStart(options)
}

export function releaseKeepAlive(token: symbol | null): void {
  if (token === null) return
  holders.delete(token)
  if (holders.size === 0) nativeStop()
}
