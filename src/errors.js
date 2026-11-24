// Typed errors. `cli.js` is the only place that turns these into exit codes and messages (plan §6).

export class ActionTrackError extends Error {
  /** @param {string} message @param {number} exitCode */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** Bad flags, bad dates, ambiguous owner, invalid config → exit 2. */
export class UsageError extends ActionTrackError {
  constructor(message) { super(message, 2); }
}

/** An id or entity that does not exist → exit 1. */
export class NotFoundError extends ActionTrackError {}

/** Database problems → exit 1. */
export class StorageError extends ActionTrackError {}

/** A draft sink failed (spawn, protocol, timeout, refused tool) → exit 1. */
export class SinkError extends ActionTrackError {}
