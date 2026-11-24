import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Clock, DollarSign, LineChart, Plus, Search, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { formatDailyFeatureValue, loadDailyFeatureCatalog, parseDailyFeatureValue, supportsCurrencySymbol, supportsMagnitudeSuffix, supportsPercentageSymbol, supportsRatioSymbol, usesFormattedNumericInput, type DailyFeatureCondition, type DailyFeatureInfo } from './api';
import { BIGCAPS_GROUP_ORDER, compareFilterFields, featureGroup, fieldLabel } from './dailyFilterFields';
import { Button } from '../../shared/components/ui/button';
import { Input } from '../../shared/components/ui/input';
import { Label } from '../../shared/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../shared/components/ui/dialog';

type Operator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'ne';
type ValueMode = 'static' | 'field';

const DEFAULT_DATA_ROOT = 'C:\\BigCaps\\data';
const OPERATOR_OPTIONS: Array<{ value: Operator; label: string }> = [
  { value: 'gte', label: '≥' },
  { value: 'gt', label: '>' },
  { value: 'lte', label: '≤' },
  { value: 'lt', label: '<' },
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
];

function formatValueForInput(value: number | undefined, field: string): string {
  return formatDailyFeatureValue(value, field);
}

function categoryIcon(group: string) {
  if (group.includes('Size') || group.includes('Liquidity')) return SlidersHorizontal;
  if (group.includes('Price') || group.includes('Gap')) return DollarSign;
  if (group.includes('Momentum')) return TrendingUp;
  if (group.includes('Moving')) return BarChart3;
  if (group.includes('Volatility')) return Activity;
  if (group.includes('Timing')) return Clock;
  return LineChart;
}

export default function DailyFilterComposerDialog({
  dataRoot,
  onAdd,
  onUpdate,
  triggerClassName,
  fullWidthTrigger = false,
  initialCondition,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: {
  dataRoot: string;
  onAdd: (condition: DailyFeatureCondition) => void;
  onUpdate?: (condition: DailyFeatureCondition) => void;
  triggerClassName?: string;
  fullWidthTrigger?: boolean;
  initialCondition?: DailyFeatureCondition;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [catalog, setCatalog] = useState<DailyFeatureInfo[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [group, setGroup] = useState('');
  const [field, setField] = useState('');
  const [operator, setOperator] = useState<Operator>('gte');
  const [value, setValue] = useState('');
  const [fieldSearch, setFieldSearch] = useState('');
  const [compareSearch, setCompareSearch] = useState('');
  const [valueMode, setValueMode] = useState<ValueMode>('static');
  const [compareField, setCompareField] = useState('');
  const [formError, setFormError] = useState('');

  const filterFields = catalog;
  const groups = useMemo(() => BIGCAPS_GROUP_ORDER.filter((name) => filterFields.some((item) => featureGroup(item.name) === name)), [filterFields]);
  const currentFields = useMemo(() => filterFields.filter((item) => featureGroup(item.name) === group && (!fieldSearch.trim() || `${fieldLabel(item.name)} ${item.name}`.toLowerCase().includes(fieldSearch.trim().toLowerCase()))), [filterFields, group, fieldSearch]);
  const compareFields = useMemo(() => filterFields.filter((item) => item.name !== field && (!compareSearch.trim() || `${fieldLabel(item.name)} ${item.name}`.toLowerCase().includes(compareSearch.trim().toLowerCase()))), [filterFields, field, compareSearch]);
  const selectedField = filterFields.find((item) => item.name === field) ?? null;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCatalogLoading(true);
    setCatalogError(null);
    void loadDailyFeatureCatalog(dataRoot || DEFAULT_DATA_ROOT)
      .then((items) => {
        if (!active) return;
        const next = items.filter((item) => item.filterable && item.name !== 'rth_return_pct' && !item.name.startsWith('pct_rank_') && item.name !== 'ema_50');
        // momentum_3d is part of the BigCaps daily feature schema. Keep it
        // selectable when an older running backend returns a stale catalog.
        if (!next.some((item) => item.name === 'momentum_3d')) {
          const oneWeekIndex = next.findIndex((item) => item.name === 'momentum_1w');
          next.splice(oneWeekIndex < 0 ? next.length : oneWeekIndex, 0, {
            name: 'momentum_3d',
            dataType: 'Float64',
            filterable: true,
          });
        }
        next.sort(compareFilterFields);
        setCatalog(next);
        const firstGroup = BIGCAPS_GROUP_ORDER.find((name) => next.some((item) => featureGroup(item.name) === name)) ?? '';
        setGroup(initialCondition ? featureGroup(initialCondition.field) : firstGroup);
        setField((current) => current || initialCondition?.field || next[0]?.name || '');
      })
      .catch((error: unknown) => { if (active) setCatalogError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [open, dataRoot]);

  useEffect(() => {
    if (!open || !initialCondition || catalog.length === 0) return;
    const validOperator = OPERATOR_OPTIONS.some((item) => item.value === initialCondition.operator);
    setGroup(featureGroup(initialCondition.field));
    setField(initialCondition.field);
    setOperator(validOperator ? initialCondition.operator as Operator : 'gte');
    setValueMode(initialCondition.compareTo ? 'field' : 'static');
    setCompareField(initialCondition.compareTo ?? '');
    setValue(formatValueForInput(initialCondition.value, initialCondition.field));
    setFieldSearch('');
    setCompareSearch('');
    setFormError('');
  }, [open, initialCondition, catalog]);

  const resetForm = () => {
    setField('');
    setOperator('gte');
    setValue('');
    setFieldSearch('');
    setCompareSearch('');
    setValueMode('static');
    setCompareField('');
    setFormError('');
  };

  const handleOpenChange = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
    if (!next) resetForm();
  };

  const handlePickField = (item: DailyFeatureInfo) => {
    setField(item.name);
    setOperator('gte');
    setValueMode('static');
    setCompareField('');
    setValue('');
  };

  const handleAddFilter = () => {
    setFormError('');
    if (!field) { setFormError('Choose a feature.'); return; }
    if (valueMode === 'field') {
      if (!compareField || compareField === field) { setFormError('Choose a different feature to compare.'); return; }
      (onUpdate ?? onAdd)({ field, operator, compareTo: compareField });
      handleOpenChange(false);
      return;
    }
    const numericValue = parseDailyFeatureValue(value, field);
    if (numericValue === null) { setFormError('Enter a valid numeric value.'); return; }
    (onUpdate ?? onAdd)({ field, operator, value: numericValue });
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {showTrigger && <DialogTrigger asChild>
        <Button variant="outline" className={[
          fullWidthTrigger ? 'w-full justify-start' : '',
          'border-[rgba(22,101,52,0.3)] text-[#15803D] hover:border-[rgba(22,101,52,0.5)] hover:bg-[rgba(22,101,52,0.08)]',
          triggerClassName ?? '',
        ].join(' ')}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Filter
        </Button>
      </DialogTrigger>}
      <DialogContent className="flex flex-col overflow-hidden border border-[rgba(255,255,255,0.08)] bg-gradient-to-br from-[#151B23] via-[#131821] to-[#0F141B] p-0 text-[#E1E7EF] shadow-2xl" style={{ width: 'min(1180px, calc(100vw - 2rem))', maxWidth: 'none', height: 'min(820px, 90vh)', maxHeight: '90vh' }}>
        <DialogHeader className="border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-5 py-4">
          <DialogTitle className="text-[15px] font-semibold text-[#E1E7EF]">{onUpdate ? 'Edit filter' : 'Field definitions'}</DialogTitle>
          <DialogDescription className="text-sm text-[#8F9BB0]">{onUpdate ? 'Update the selected condition, then save your changes.' : 'Pick General, browse a feature group, then define the operator and value.'}</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[282px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col overflow-hidden border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-4 lg:border-b-0 lg:border-r">
            <div className="shrink-0 space-y-3">
              <div><Label className="text-[11px] font-semibold uppercase tracking-wide text-[#718096]">Categories</Label><p className="mt-1 text-[11px] text-[#4A5568]">Select a category to browse related features.</p></div>
              <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-1.5">
                <button type="button" className="min-h-[34px] w-full rounded-lg bg-[rgba(22,101,52,0.14)] px-2.5 py-1.5 text-left text-[11px] font-semibold leading-tight text-[#86EFAC] shadow-[0_0_0_1px_rgba(22,101,52,0.12)]">General</button>
              </div>
              <div className="relative"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#718096]" /><Input value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} placeholder="Search fields" className="h-9 border-[rgba(255,255,255,0.08)] bg-[#0D1117] pl-8 text-[13px] text-[#E1E7EF]" /></div>
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              {catalogLoading ? <div className="py-8 text-center text-[12px] text-[#8F9BB0]">Loading daily feature catalog…</div>
                : catalogError ? <div className="rounded-lg border border-red-400/20 bg-red-500/[0.06] p-3 text-[11px] text-red-200">{catalogError}</div>
                  : <div className="space-y-1.5">
                    <div className="sticky top-0 z-10 -mx-1 bg-[#171D26] px-1 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#718096]">General</div>
                    {groups.map((name) => {
                      const groupFields = filterFields.filter((item) => featureGroup(item.name) === name);
                      const matchesSearch = groupFields.some((item) => !fieldSearch.trim() || `${fieldLabel(item.name)} ${item.name}`.toLowerCase().includes(fieldSearch.trim().toLowerCase()));
                      const Icon = categoryIcon(name);
                      return <button key={name} type="button" onClick={() => { setGroup(name); setField(''); }} className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all ${group === name ? 'border-[rgba(220,38,38,0.24)] bg-[rgba(220,38,38,0.10)] text-[#E1E7EF]' : 'border-[rgba(255,255,255,0.06)] bg-[#0D1117] text-[#A0AEC0] hover:border-white/[0.12] hover:bg-white/[0.03]'} ${matchesSearch ? '' : 'opacity-40'}`}><span className="flex min-w-0 items-center gap-3"><Icon className="h-4 w-4 shrink-0 text-[#86EFAC]" /><span className="min-w-0 text-[12px] font-medium leading-tight">{name}</span></span><span className="rounded-md border border-white/[0.06] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-[#A7B1C2]">{groupFields.length}</span></button>;
                    })}
                  </div>}
            </div>
          </aside>

          <div className="flex min-h-0 flex-col overflow-hidden bg-transparent p-5">
            <div className="mb-4 flex shrink-0 items-start justify-between gap-4"><div><h3 className="text-[14px] font-semibold tracking-tight text-[#E1E7EF]">{group || 'Daily features'}</h3><p className="mt-1 text-[11px] text-[#708096]">{group === 'Market Breadth' ? 'Values from the previous market close' : 'General · Pick a feature to continue.'}</p></div>{selectedField && <div className="text-right"><div className="text-[10px] uppercase tracking-wide text-[#708096]">Selected</div><div className="text-[13px] font-medium text-[#15803D]">{fieldLabel(selectedField.name)}</div></div>}</div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid justify-start gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 210px))' }}>
                {currentFields.map((item) => <button key={item.name} type="button" onClick={() => handlePickField(item)} className={`min-h-[36px] rounded-lg border px-3 py-1.5 text-[11.5px] font-medium leading-tight transition-all ${field === item.name ? 'border-[rgba(22,101,52,0.28)] bg-[rgba(22,101,52,0.12)] text-[#86EFAC] shadow-[0_0_0_1px_rgba(22,101,52,0.06)]' : 'border-[rgba(255,255,255,0.04)] bg-[#1A222D] text-[#86EFAC] hover:border-[rgba(255,255,255,0.08)] hover:bg-[#202A36]'}`}><span className="block text-center">{fieldLabel(item.name)}</span></button>)}
              </div>
            </div>

            <div className="mt-4 shrink-0 border-t border-[rgba(255,255,255,0.08)] pt-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
                <div className="space-y-2"><Label className="text-[11px] font-medium text-[#A0AEC0]">Operator</Label><div className="grid grid-cols-3 gap-1.5 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">{OPERATOR_OPTIONS.map((item) => <button key={item.value} type="button" onClick={() => setOperator(item.value)} className={`w-full rounded-lg px-2 py-2 text-[11px] font-semibold transition-all ${operator === item.value ? 'bg-[rgba(22,101,52,0.16)] text-[#86EFAC] shadow-[0_0_0_1px_rgba(22,101,52,0.12)]' : 'text-[#8F9BB0] hover:bg-white/[0.04] hover:text-[#E1E7EF]'}`}>{item.label}</button>)}</div></div>
                <div className="space-y-2"><Label className="text-[11px] font-medium text-[#A0AEC0]">Value</Label>
                  <div className="inline-flex w-full rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">{(['static', 'field'] as const).map((mode) => <button key={mode} type="button" onClick={() => { setValueMode(mode); if (mode === 'static') setCompareField(''); else setValue(''); }} className={`flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition-all ${valueMode === mode ? 'bg-[rgba(22,101,52,0.16)] text-[#86EFAC] shadow-[0_0_0_1px_rgba(22,101,52,0.12)]' : 'text-[#8F9BB0] hover:bg-white/[0.04] hover:text-[#E1E7EF]'}`}>{mode === 'static' ? 'Static Value' : 'Other Variable'}</button>)}</div>
                  {valueMode === 'static' ? <div className="relative"><label className="block"><span className="mb-1 block text-[10px] uppercase tracking-wide text-[#708096]">Value</span><Input type={usesFormattedNumericInput(field) ? 'text' : 'number'} inputMode={usesFormattedNumericInput(field) ? 'decimal' : undefined} value={value} onChange={(event) => setValue(event.target.value)} placeholder={supportsMagnitudeSuffix(field) ? (supportsCurrencySymbol(field) ? 'e.g. $500M, $1B, $1T' : 'e.g. 20K, 20M, 2B') : supportsPercentageSymbol(field) ? 'e.g. 5%' : supportsRatioSymbol(field) ? 'e.g. 2x' : 'Enter numeric value'} className="h-11 rounded-xl border-[rgba(255,255,255,0.08)] bg-[#0D1117] text-[13px] text-[#E1E7EF]" /></label></div>
                    : <div className="space-y-2"><Input value={compareSearch} onChange={(event) => setCompareSearch(event.target.value)} placeholder="Search variables" className="h-10 rounded-xl border-[rgba(255,255,255,0.08)] bg-[#0D1117] text-[13px] text-[#E1E7EF]" /><div className="grid max-h-[190px] gap-1.5 overflow-y-auto pr-1" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 210px))' }}>{compareFields.map((item) => <button key={item.name} type="button" onClick={() => setCompareField(item.name)} className={`min-h-[34px] rounded-lg border px-3 py-1.5 text-[11.5px] font-medium transition-all ${compareField === item.name ? 'border-[rgba(220,38,38,0.28)] bg-[rgba(220,38,38,0.12)] text-[#F87171]' : 'border-[rgba(255,255,255,0.04)] bg-[#1A222D] text-[#86EFAC] hover:border-[rgba(22,101,52,0.28)] hover:bg-[#202A36]'}`}>{fieldLabel(item.name)}</button>)}</div></div>}
                </div>
              </div>
              {formError && <p className="mt-3 rounded-lg border border-red-400/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-200">{formError}</p>}
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-5 py-4">
          <Button variant="outline" onClick={() => handleOpenChange(false)} className="border-[rgba(255,255,255,0.08)] bg-[#0D1117] text-[#A0AEC0] hover:bg-[rgba(255,255,255,0.04)]">Cancel</Button>
          <Button onClick={handleAddFilter} disabled={!field || catalogLoading || !!catalogError} className="bg-gradient-to-r from-[#15803D] to-[#166534] text-white hover:shadow-lg hover:shadow-[#15803D]/30 disabled:opacity-40">{onUpdate ? 'Update Filter' : <><Plus className="mr-1.5 h-3.5 w-3.5" /> Add Filter</>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
