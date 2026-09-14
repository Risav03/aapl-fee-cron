export function log(message: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (extra === undefined) {
    console.log(line);
    return;
  }
  console.log(line, extra);
}

export function logError(message: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[${new Date().toISOString()}] ${message}: ${detail}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
