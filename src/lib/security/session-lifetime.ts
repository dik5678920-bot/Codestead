/**
 * "Keep me signed in on this device": a remembered session is a persistent
 * cookie (Max-Age = expiresIn) that survives browser restarts, and any request
 * after updateAge slides both the row and the cookie forward, so a device in
 * regular use stays signed in until an explicit logout, takeover or revocation.
 */
export const PERSISTENT_SESSION_LIFETIME = {
  expiresIn: 60 * 60 * 24 * 30,
  updateAge: 60 * 60 * 24,
} as const;
