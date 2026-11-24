export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; code?: unknown };
    if (typeof value.message === 'string') {
      return typeof value.code === 'string' ? `${value.code}: ${value.message}` : value.message;
    }
    try { return JSON.stringify(error); } catch { return 'Unknown analytics error'; }
  }
  return String(error);
}
