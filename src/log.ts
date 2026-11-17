// One JSON object per line. Callers pass ids, reasons and numbers only:
// never tickets, keys, SDP, transcripts or provider payloads.

/** Structured fields for one log line. */
export type LogFields = Record<string, string | number | boolean | undefined>;

/** Where the guard writes its log lines. */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function write(stream: NodeJS.WriteStream, level: string, message: string, fields?: LogFields): void {
  stream.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields })}\n`);
}

/** Default logger: info to stdout, warn and error to stderr, one JSON object per line. */
export const jsonLogger: Logger = {
  info: (message, fields) => write(process.stdout, "info", message, fields),
  warn: (message, fields) => write(process.stderr, "warn", message, fields),
  error: (message, fields) => write(process.stderr, "error", message, fields),
};

/** Discards everything. Useful in tests. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
