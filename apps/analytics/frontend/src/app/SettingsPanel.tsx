import { useEffect, useState } from 'react';
import { Database, X } from 'lucide-react';
import { invoke, isTauri } from '@tauri-apps/api/core';

interface SettingsPanelProps {
  open: boolean;
  dataRoot: string;
  onSave: (dataRoot: string) => void;
  onUpdated: (dataRoot: string) => void;
  onClose: () => void;
}

const credentialFields = [
  ['apiKey', 'Massive REST API key'],
  ['accessKey', 'Massive Flat Files access key'],
] as const;

const inputClass = 'mt-2 h-10 w-full rounded-lg border border-white/[0.09] bg-[#0a0e14] px-3 text-xs text-slate-200 outline-none focus:border-green-600/60';
const secondaryButton = 'rounded-lg border border-white/[0.08] px-4 py-2.5 text-xs font-semibold text-slate-300 hover:bg-white/[0.05] disabled:opacity-40';

export function SettingsPanel({ open, dataRoot, onSave, onUpdated, onClose }: SettingsPanelProps) {
  const [draftRoot, setDraftRoot] = useState(dataRoot);
  const [credentials, setCredentials] = useState({ apiKey: '', accessKey: '' });
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; error: boolean }>();

  useEffect(() => {
    if (open) setDraftRoot(dataRoot);
  }, [open, dataRoot]);

  if (!open) return null;

  const save = () => {
    const root = draftRoot.trim();
    if (!root || busy) return;
    onSave(root);
    onClose();
  };

  async function update(range: boolean) {
    const root = draftRoot.trim();
    if (!root || busy || (range && (!start || !end || start > end))) return;
    setBusy(true);
    setResult(undefined);
    try {
      const summary = await invoke<string>('update_dataset', {
        request: { dataRoot: root, start: range ? start : null, end: range ? end : null, ...credentials },
      });
      onUpdated(root);
      setResult({ message: ['Data update complete.', summary].filter(Boolean).join('\n'), error: false });
    } catch (error) {
      setResult({ message: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <section
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/[0.1] bg-[#111720] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div className="flex items-center gap-3">
            <Database className="h-4 w-4 text-green-600" />
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Analytics data settings</h2>
              <p className="mt-1 text-[11px] text-slate-500">Daily bars and daily feature partitions</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-white/[0.05] hover:text-slate-200"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-5 p-5">
          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Dataset root</span>
            <input
              value={draftRoot}
              disabled={busy}
              onChange={(event) => setDraftRoot(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
              className="mt-2 h-11 w-full rounded-lg border border-white/[0.09] bg-[#0a0e14] px-3 font-mono text-xs text-slate-200 outline-none focus:border-green-600/60"
              placeholder="C:\\BigCaps\\data"
            />
          </label>
          <fieldset disabled={busy} className="space-y-3 border-t border-white/[0.08] pt-4">
            <legend className="pr-2 text-xs font-semibold text-slate-100">Update market data</legend>
            <p className="text-xs text-slate-400">
              Blank fields use the environment. The Flat Files secret key can also be read from keys.env in the sibling .local directory.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {credentialFields.map(([name, label]) => (
                <label key={name} className="text-xs text-slate-300">
                  {label}
                  <input
                    type="password"
                    autoComplete="off"
                    value={credentials[name]}
                    onChange={(event) => setCredentials({ ...credentials, [name]: event.target.value })}
                    className={inputClass}
                  />
                </label>
              ))}
              <label className="text-xs text-slate-300">
                From
                <input type="date" value={start} onChange={(event) => setStart(event.target.value)} className={inputClass} />
              </label>
              <label className="text-xs text-slate-300">
                To
                <input type="date" min={start || undefined} value={end} onChange={(event) => setEnd(event.target.value)} className={inputClass} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryButton} disabled={!isTauri() || !draftRoot.trim()} onClick={() => void update(false)}>
                Update to latest session
              </button>
              <button type="button" className={secondaryButton} disabled={!isTauri() || !draftRoot.trim() || !start || !end || start > end} onClick={() => void update(true)}>
                Download date range
              </button>
            </div>
          </fieldset>
          {!isTauri() && <p className="text-xs text-slate-400">Run the BigCaps desktop app to update market data.</p>}
          {busy && <p role="status" className="text-xs text-green-300">Updating the dataset…</p>}
          {result && (
            <pre role={result.error ? 'alert' : 'status'} className={`whitespace-pre-wrap break-words rounded-lg bg-[#0a0e14] p-3 text-xs ${result.error ? 'text-red-300' : 'text-green-300'}`}>
              {result.message}
            </pre>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/[0.08] px-4 py-2.5 text-xs font-semibold text-slate-400 hover:bg-white/[0.04] hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !draftRoot.trim()}
              className="rounded-lg bg-green-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-green-600 disabled:opacity-40"
            >
              Save and load fields
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
