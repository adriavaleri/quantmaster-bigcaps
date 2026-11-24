type WorkerBarCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volumeDelta?: number;
  vwap?: number;
};

type WorkerRequest = {
  source: WorkerBarCandle[];
  sessionDate: string;
  timeframes: Array<'1s' | '3s' | '5s' | '10s' | '15s' | '30s'>;
};

const TIMEFRAME_SECONDS: Record<WorkerRequest['timeframes'][number], number> = {
  '1s': 1,
  '3s': 3,
  '5s': 5,
  '10s': 10,
  '15s': 15,
  '30s': 30,
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { source, sessionDate, timeframes } = event.data;
  const results: Record<string, WorkerBarCandle[]> = {};

  for (const timeframe of timeframes) {
    results[timeframe] = aggregateBySeconds(source, TIMEFRAME_SECONDS[timeframe], sessionDate);
  }

  self.postMessage({ results });
};

function aggregateBySeconds(source: WorkerBarCandle[], seconds: number, sessionDate: string): WorkerBarCandle[] {
  const buckets = new Map<number, WorkerBarCandle>();

  for (const candle of source) {
    const unix = parseCandleTime(candle.time, sessionDate);
    if (!Number.isFinite(unix)) continue;
    const bucket = Math.floor(unix / seconds) * seconds;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: formatUnixAsNyLocal(bucket),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume || 0),
        volumeDelta: Number(candle.volumeDelta || 0),
        vwap: candle.vwap,
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += Number(candle.volume || 0);
    existing.volumeDelta = Number(existing.volumeDelta || 0) + Number(candle.volumeDelta || 0);
    existing.vwap = candle.vwap;
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([, candle]) => candle);
}

function parseCandleTime(raw: string, fallbackDate?: string): number {
  const clean = String(raw).trim().replace(/^"+|"+$/g, '');
  if (fallbackDate && /^\d{2}:\d{2}(?::\d{2})?$/.test(clean)) {
    return parseCandleTime(`${fallbackDate.slice(0, 10)} ${clean.length === 5 ? `${clean}:00` : clean}`);
  }
  const nyLocal = clean.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (nyLocal && !(/[zZ]|[+-]\d{2}:?\d{2}$/.test(clean))) {
    return nyLocalToUnixSec(
      Number(nyLocal[1]), Number(nyLocal[2]), Number(nyLocal[3]),
      Number(nyLocal[4]), Number(nyLocal[5]), Number(nyLocal[6]),
    );
  }
  const date = new Date(clean.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(clean) ? '' : 'Z'));
  return Math.floor(date.getTime() / 1000);
}

function nyLocalToUnixSec(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(utcGuess);
  return Math.floor((utcGuess - offset) / 1000);
}

function getTimeZoneOffsetMs(utcMillis: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMillis));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return zonedAsUtc - utcMillis;
}

function formatUnixAsNyLocal(unix: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(unix * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}


