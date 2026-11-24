import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Check, ChevronDown, ChevronUp, Download, FileSpreadsheet, Layers3 } from 'lucide-react';
import FilterBar from '../filters/FilterBar';
import { useFilters } from '../filters/FilterContext';
import { loadDailyFeatureCatalog, type DailyFeatureInfo } from '../daily/api';
import { buildTableColumns, downloadDailyCsv, withExplorerSearch } from '../daily/dailyTable';

export default function Exports() {
  const { dataRoot } = useOutletContext<{ dataRoot: string }>();
  const { dailySearch, explorerView } = useFilters();
  const { filter, isLoading, resultCount } = dailySearch;
  const [catalog, setCatalog] = useState<DailyFeatureInfo[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const tableColumns = useMemo(() => buildTableColumns(catalog), [catalog]);
  const defaultColumns = useMemo(() => new Set(tableColumns.filter((column) => column.defaultVisible).map((column) => column.key)), [tableColumns]);
  const sections = useMemo(() => [...new Set(tableColumns.map((column) => column.section))], [tableColumns]);
  const [columnSelection, setSelectedColumns] = useState<Set<string> | null>(null);
  const selectedColumns = columnSelection ?? defaultColumns;
  const [collapsedSections, setCollapsedSections] = useState(new Set<string>());
  const [isExporting, setIsExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ key: string; count: number } | null>(null);
  const selectedFields = tableColumns.filter((column) => selectedColumns.has(column.key));
  const queryKey = JSON.stringify([dataRoot, filter, explorerView]);
  const displayTotal = exportResult?.key === queryKey ? exportResult.count : explorerView.search.trim() ? null : resultCount;
  const canExport = filter !== null && !isLoading && resultCount !== null && dailySearch.error === null;

  useEffect(() => {
    let active = true;
    setCatalog([]);
    setCatalogError(null);
    void loadDailyFeatureCatalog(dataRoot)
      .then((items) => { if (active) setCatalog(items); })
      .catch((cause) => { if (active) setCatalogError(String(cause)); });
    return () => { active = false; };
  }, [dataRoot]);

  const toggleColumn = (key: string) => setSelectedColumns((current) => {
    const next = new Set(current ?? defaultColumns);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const toggleSection = (section: string) => {
    const keys = tableColumns.filter((field) => field.section === section).map((field) => field.key);
    const allSelected = keys.every((key) => selectedColumns.has(key));
    setSelectedColumns((current) => {
      const next = new Set(current ?? defaultColumns);
      keys.forEach((key) => allSelected ? next.delete(key) : next.add(key));
      return next;
    });
  };

  const handleExport = async () => {
    if (!filter || !canExport || !selectedFields.length || isExporting) return;
    setIsExporting(true);
    setExported(false);
    setError(null);
    try {
      const count = await downloadDailyCsv(dataRoot, withExplorerSearch(filter, explorerView.search), explorerView.sortCol, explorerView.sortDesc, selectedFields);
      setExportResult({ key: queryKey, count });
      setExported(true);
      window.setTimeout(() => setExported(false), 2500);
    } catch (cause) {
      setError(`CSV export failed: ${String(cause)}`);
    } finally {
      setIsExporting(false);
    }
  };

  return <div className="flex min-h-full flex-col bg-[#0B0E13]">
    <FilterBar />
    <main className="flex-1 px-3 pb-8 pt-3 sm:px-5 sm:pt-5">
      <header className="mb-4 flex flex-col justify-between gap-3 border-b border-white/[.07] pb-4 sm:flex-row sm:items-end">
        <div><div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.16em] text-[#6E7D92]"><FileSpreadsheet className="h-3.5 w-3.5 text-[#D6A748]" /> Exports</div><h1 className="text-xl font-semibold tracking-tight text-[#E7ECF3]">Daily CSV Export</h1><p className="mt-1 text-[11px] leading-5 text-[#7E8A9C]">Choose columns from the applied daily query.</p></div>
        <div className="flex gap-2"><SummaryPill label="Records" value={displayTotal?.toLocaleString() ?? '—'} /><SummaryPill label="Columns" value={String(selectedFields.length)} /></div>
      </header>

      <div className="mx-auto grid max-w-[1440px] gap-3 xl:grid-cols-[minmax(0,1fr)_330px]">
        <section className="rounded-xl border border-white/[.075] bg-[#11151C] shadow-[0_14px_35px_rgba(0,0,0,.18)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.065] px-4 py-3"><div><h2 className="text-[13px] font-semibold text-[#DCE3ED]">Select columns</h2><p className="mt-0.5 text-[10px] text-[#68768A]">Daily query columns</p></div><div className="flex gap-2"><SmallButton label="Reset default" onClick={() => setSelectedColumns(null)} /><SmallButton label="Select all" onClick={() => setSelectedColumns(new Set(tableColumns.map((field) => field.key)))} /></div></div>
          <div className="space-y-2 p-3">
            {sections.map((section) => {
              const fields = tableColumns.filter((field) => field.section === section);
              const selected = fields.filter((field) => selectedColumns.has(field.key)).length;
              const expanded = !collapsedSections.has(section);
              return <div key={section} className="overflow-hidden rounded-lg border border-white/[.065] bg-[#0D1117]">
                <div className="flex items-center gap-3 px-3 py-2.5"><button type="button" onClick={() => setCollapsedSections((current) => { const next = new Set(current); if (next.has(section)) next.delete(section); else next.add(section); return next; })} className="flex min-w-0 flex-1 items-center gap-2 text-left"><Layers3 className="h-3.5 w-3.5 text-green-300" /><span className="text-[11px] font-semibold uppercase tracking-[.08em] text-[#B8C4D9]">{section}</span><span className="font-mono text-[9px] text-[#5E6B7D]">{selected}/{fields.length}</span>{expanded ? <ChevronUp className="ml-auto h-3.5 w-3.5 text-[#536176]" /> : <ChevronDown className="ml-auto h-3.5 w-3.5 text-[#536176]" />}</button><button type="button" onClick={() => toggleSection(section)} className="rounded-md border border-green-700/30 bg-green-900/[.18] px-2 py-1 text-[9px] font-semibold text-green-200">{selected === fields.length ? 'Clear group' : 'Select group'}</button></div>
                {expanded && <div className="grid gap-1.5 border-t border-white/[.055] p-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{fields.map((field) => { const checked = selectedColumns.has(field.key); return <button key={field.key} type="button" onClick={() => toggleColumn(field.key)} className={`flex min-h-[34px] items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${checked ? 'border-green-700/40 bg-green-900/[.22] text-[#DDEAF4]' : 'border-white/[.045] bg-[#111720] text-[#728095] hover:border-white/[.10]'}`}><span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${checked ? 'border-green-600/60 bg-green-700/30' : 'border-white/15'}`}>{checked && <Check className="h-2.5 w-2.5 text-green-200" />}</span><span className="truncate text-[10px] font-medium">{field.label}</span></button>; })}</div>}
              </div>;
            })}
          </div>
        </section>

        <aside className="h-fit rounded-xl border border-white/[.075] bg-[#11151C] p-4 shadow-[0_14px_35px_rgba(0,0,0,.18)] xl:sticky xl:top-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-green-700/40 bg-green-900/[.22]"><FileSpreadsheet className="h-5 w-5 text-green-200" /></div><h2 className="mt-4 text-[14px] font-semibold text-[#E7ECF3]">Download summary</h2><p className="mt-1 text-[10px] leading-5 text-[#68768A]">One row per ticker and trading day. Includes every page and uses the Data Explorer search and sort order.</p>
          <div className="mt-4 space-y-2 border-y border-white/[.06] py-3"><SummaryRow label="Records" value={displayTotal?.toLocaleString() ?? '—'} /><SummaryRow label="Columns selected" value={String(selectedFields.length)} /><SummaryRow label="Active filters" value={String(filter?.conditions.length ?? 0)} /></div>
          <div className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-white/[.055] bg-[#0D1117] p-2"><div className="mb-2 text-[9px] font-semibold uppercase tracking-[.1em] text-[#59677A]">CSV columns</div><div className="flex flex-wrap gap-1">{selectedFields.map((field) => <span key={field.key} className="rounded border border-white/[.06] bg-white/[.025] px-1.5 py-1 text-[8px] text-[#8F9BB0]">{field.label}</span>)}</div>{!selectedFields.length && <div className="py-4 text-center text-[10px] text-[#59677A]">Select at least one column</div>}</div>
          {!canExport && <p className="mt-3 text-[10px] text-[#9AA7B8]">Run Search to apply the daily filters.</p>}
          {catalogError && <p className="mt-3 text-[10px] text-red-200">Could not load optional columns. {catalogError}</p>}
          {error && <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/[.06] p-2 text-[10px] text-red-200">{error}</div>}
          <button type="button" onClick={handleExport} disabled={!canExport || !selectedFields.length || isExporting} className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-green-700/40 bg-green-900/[.24] text-[11px] font-semibold text-green-100 transition-colors hover:bg-green-800/[.35] disabled:cursor-not-allowed disabled:opacity-35">{exported ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}{isExporting ? 'Preparing CSV…' : exported ? 'CSV downloaded' : 'Download CSV'}</button>
        </aside>
      </div>
    </main>
  </div>;
}

function SummaryPill({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-white/[.07] bg-[#11161E] px-3 py-2 text-right"><div className="text-[8px] uppercase tracking-[.12em] text-[#59677A]">{label}</div><div className="mt-0.5 font-mono text-sm font-semibold text-[#CED7E4]">{value}</div></div>; }
function SummaryRow({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between text-[10px]"><span className="text-[#718096]">{label}</span><span className="font-mono font-semibold text-[#D8E2EF]">{value}</span></div>; }
function SmallButton({ label, onClick }: { label: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="rounded-md border border-white/[.08] bg-[#151B23] px-2.5 py-1.5 text-[9px] font-semibold text-[#9AA7B8] hover:border-green-700/40 hover:text-green-100">{label}</button>; }
