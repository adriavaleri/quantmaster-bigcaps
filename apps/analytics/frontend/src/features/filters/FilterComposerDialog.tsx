import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Clock, DollarSign, LineChart, Plus, Search, SlidersHorizontal, TrendingUp } from 'lucide-react';
import { useFilters, type Filter } from './FilterContext';
import { SESSION_INDEX_FIELDS, FIELD_GROUPS, type FilterField } from './sessionIndexFields';
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

interface FilterComposerDialogProps {
  triggerClassName?: string;
  triggerLabel?: string;
  fullWidthTrigger?: boolean;
  editingFilter?: Filter | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  selectionOnly?: boolean;
  fieldPredicate?: (field: FilterField) => boolean;
  onFieldSelect?: (field: FilterField) => void;
}

const CATEGORY_HINTS: Record<string, string> = {};
const groupKey = (section: string, group: string) => `${section}::${group}`;
const firstGroupKey = groupKey(FIELD_GROUPS[0].section, FIELD_GROUPS[0].group);
const SHORT_SECTION_LABELS: Record<string, string> = {
  'GENERAL': 'General',
  'PREVIOUS AFTER HOURS': 'Prev AH',
  'OVERNIGHT': 'Overnight',
  'PREMARKET': 'Premarket',
  'RTH': 'RTH',
  'AFTER HOURS': 'After Hours',
};

function categoryIcon(group: string) {
  if (group === 'Identity') return SlidersHorizontal;
  if (group.includes('Price') || group === 'VWAP') return DollarSign;
  if (group.includes('Volume')) return BarChart3;
  if (group.includes('Fade')) return TrendingUp;
  if (group.includes('Spike') || group === 'Behavior') return Activity;
  if (group.includes('Return')) return LineChart;
  if (group.includes('Timing')) return Clock;
  return LineChart;
}

export default function FilterComposerDialog({
  triggerClassName,
  triggerLabel = 'Add Filter',
  fullWidthTrigger = false,
  editingFilter = null,
  open: controlledOpen,
  onOpenChange: onControlledOpenChange,
  selectionOnly = false,
  fieldPredicate,
  onFieldSelect,
}: FilterComposerDialogProps) {
  const { addFilter, updateFilter } = useFilters();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [selectedGroup, setSelectedGroup] = useState(firstGroupKey);
  const [compareGroup, setCompareGroup] = useState(firstGroupKey);
  const [newFilterField, setNewFilterField] = useState('');
  const [newFilterOperator, setNewFilterOperator] = useState<Filter['operator']>('>=');
  const [newFilterValue, setNewFilterValue] = useState('');
  const [fieldSearch, setFieldSearch] = useState('');
  const [compareSearch, setCompareSearch] = useState('');
  const [valueMode, setValueMode] = useState<'static' | 'field'>('static');
  const [compareField, setCompareField] = useState('');
  const [lookbackDays, setLookbackDays] = useState('30');

  const filterFields = useMemo(
    () => SESSION_INDEX_FIELDS.filter((field) => fieldPredicate?.(field) ?? true),
    [fieldPredicate],
  );
  const firstAvailableGroupKey = useMemo(
    () => {
      const firstField = filterFields[0];
      return firstField ? groupKey(firstField.section, firstField.group) : firstGroupKey;
    },
    [filterFields],
  );
  const fieldSections = useMemo(
    () => FIELD_GROUPS.reduce<string[]>((sections, group) => {
      if (!sections.includes(group.section)) sections.push(group.section);
      return sections;
    }, []),
    [],
  );
  const visibleGroups = useMemo(
    () => FIELD_GROUPS.filter(({ section, group }) => {
      const groupFields = filterFields.filter((f) => f.section === section && f.group === group);
      if (!fieldSearch.trim()) return groupFields.length > 0;
      const q = fieldSearch.trim().toLowerCase();
      return groupFields.some((f) => f.label.toLowerCase().includes(q) || f.value.toLowerCase().includes(q));
    }),
    [fieldSearch, filterFields],
  );

  const selectedGroupInfo = FIELD_GROUPS.find(({ section, group }) => groupKey(section, group) === selectedGroup) ?? FIELD_GROUPS[0];
  const selectedSection = selectedGroupInfo.section;
  const selectedSectionGroups = FIELD_GROUPS.filter((item) => item.section === selectedSection);
  const currentFields = filterFields.filter((f) => groupKey(f.section, f.group) === selectedGroup).filter((f) => {
    if (!fieldSearch.trim()) return true;
    const q = fieldSearch.trim().toLowerCase();
    return f.label.toLowerCase().includes(q) || f.value.toLowerCase().includes(q);
  });

  const compareFields = filterFields
    .filter((f) => f.type === 'numeric')
    .filter((f) => groupKey(f.section, f.group) === compareGroup)
    .filter((f) => f.value !== newFilterField)
    .filter((f) => {
      if (!compareSearch.trim()) return true;
      const q = compareSearch.trim().toLowerCase();
      return f.label.toLowerCase().includes(q) || f.value.toLowerCase().includes(q);
    });

  const selectedField = filterFields.find((f) => f.value === newFilterField) ?? null;
  const selectedCompareField = filterFields.find((f) => f.value === compareField) ?? null;
  const valueSuffix = getValueSuffix(selectedField);

  const resetForm = () => {
    setSelectedGroup(selectionOnly ? firstAvailableGroupKey : firstGroupKey);
    setCompareGroup(firstGroupKey);
    setNewFilterField('');
    setNewFilterOperator('>=');
    setNewFilterValue('');
    setFieldSearch('');
    setCompareSearch('');
    setValueMode('static');
    setCompareField('');
    setLookbackDays('30');
  };

  useEffect(() => {
    if (open && selectionOnly) setSelectedGroup(firstAvailableGroupKey);
  }, [firstAvailableGroupKey, open, selectionOnly]);

  useEffect(() => {
    if (!open || !editingFilter) return;
    const field = filterFields.find((item) => item.value === editingFilter.field);
    if (!field) return;
    setSelectedGroup(groupKey(field.section, field.group));
    setNewFilterField(field.value);
    setNewFilterOperator(editingFilter.operator ?? (field.type === 'numeric' ? '>=' : '='));
    setValueMode(editingFilter.valueMode ?? (editingFilter.compareField ? 'field' : 'static'));
    setCompareField(editingFilter.compareField ?? '');
    setLookbackDays(editingFilter.lookbackDays ? String(editingFilter.lookbackDays) : '30');
    setNewFilterValue(editingFilter.value == null ? '' : String(field.unit === 'volume' && typeof editingFilter.value === 'number' ? editingFilter.value / 1_000_000 : editingFilter.value));
  }, [open, editingFilter?.id]);

  const handleOpenChange = (next: boolean) => {
    setInternalOpen(next);
    onControlledOpenChange?.(next);
    if (!next) resetForm();
  };

  const handlePickField = (field: FilterField) => {
    setNewFilterField(field.value);
    setNewFilterOperator(field.type === 'numeric' ? '>=' : '=');
    if (field.type !== 'numeric') {
      setValueMode('static');
      setCompareField('');
    }
    if (field.value === 'change_pct' && !lookbackDays) setLookbackDays('30');
  };

  const handlePickSection = (section: string) => {
    const firstGroup = FIELD_GROUPS.find((group) => group.section === section);
    if (!firstGroup) return;
    setSelectedGroup(groupKey(firstGroup.section, firstGroup.group));
  };

  const handleAddFilter = () => {
    const field = filterFields.find((f) => f.value === newFilterField);
    if (!field) return;

    if (selectionOnly) {
      onFieldSelect?.(field);
      handleOpenChange(false);
      return;
    }

    const isVolumeField = field.unit === 'volume';
    const isChangeField = field.value === 'change_pct';
    const useFieldCompare = valueMode === 'field' && !!compareField;
    if (useFieldCompare && !selectedCompareField) return;
    if (!useFieldCompare && !newFilterValue) return;
    const parsedLookbackDays = Number(lookbackDays);
    if (isChangeField && (!Number.isInteger(parsedLookbackDays) || parsedLookbackDays < 1 || parsedLookbackDays > 5000)) return;

    const numericValue = Number(newFilterValue);
    const value = field.type === 'numeric' && !useFieldCompare
      ? (isVolumeField ? numericValue * 1_000_000 : numericValue)
      : field.type === 'boolean' && !useFieldCompare
        ? newFilterValue === 'true'
        : newFilterValue;
    const displayValue = useFieldCompare && selectedCompareField
      ? selectedCompareField.label
      : isVolumeField
        ? `${newFilterValue}M`
        : `${newFilterValue}${getValueSuffix(field)}`;
    const displayFieldLabel = isChangeField ? `Change % over ${parsedLookbackDays} days` : field.label;
    const nextFilter: Filter = {
      id: editingFilter?.id ?? `filter-${Date.now()}`,
      label: `${displayFieldLabel} ${newFilterOperator} ${displayValue}`,
      field: newFilterField,
      type: field.type,
      operator: newFilterOperator as Filter['operator'],
      value: useFieldCompare ? null : value,
      valueMode,
      compareField: useFieldCompare ? compareField : undefined,
      lookbackDays: isChangeField ? parsedLookbackDays : undefined,
    };
    if (editingFilter) updateFilter(nextFilter);
    else addFilter(nextFilter);

    handleOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className={[
            fullWidthTrigger ? 'w-full justify-start' : '',
            'border-[rgba(22,101,52,0.45)] text-green-500 hover:border-[rgba(21,128,61,0.7)] hover:bg-[rgba(22,101,52,0.18)]',
            triggerClassName ?? '',
          ].join(' ')}
        >
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="p-0 overflow-hidden flex flex-col bg-gradient-to-br from-[#151B23] via-[#131821] to-[#0F141B] border border-[rgba(255,255,255,0.08)] text-[#E1E7EF] shadow-2xl"
        style={{
          width: 'min(1180px, calc(100vw - 2rem))',
          maxWidth: 'none',
          height: 'min(820px, 90vh)',
          maxHeight: '90vh',
        }}
      >
        <DialogHeader className="px-5 py-4 border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)]">
          <DialogTitle className="text-[15px] font-semibold text-[#E1E7EF]">Field definitions</DialogTitle>
          <DialogDescription className="text-sm text-[#8f9bb0]">
            {selectionOnly ? 'Pick a field to use on the vertical axis.' : 'Pick a category, choose a field, then define the operator and value.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-[282px_minmax(0,1fr)] min-h-0 flex-1 overflow-hidden">
          <aside className="border-b lg:border-b-0 lg:border-r border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-4 overflow-hidden flex flex-col min-h-0">
            <div className="space-y-3 shrink-0">
              <div>
                <Label className="text-[11px] font-semibold uppercase tracking-wide text-[#718096]">Categories</Label>
                <p className="text-[11px] text-[#4A5568] mt-1">Select a group to browse related filters.</p>
              </div>

              <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-1.5">
                {fieldSections.map((section) => {
                  const active = selectedSection === section;
                  return (
                    <button
                      key={section}
                      type="button"
                      onClick={() => handlePickSection(section)}
                      className={[
                        'min-h-[34px] rounded-lg px-2.5 py-1.5 text-[11px] font-semibold leading-tight transition-all duration-150',
                        active
                          ? 'bg-[rgba(22,101,52,0.28)] text-green-200 shadow-[0_0_0_1px_rgba(21,128,61,0.35)]'
                          : 'text-[#8F9BB0] hover:text-[#E1E7EF] hover:bg-[rgba(255,255,255,0.04)]',
                      ].join(' ')}
                    >
                      {SHORT_SECTION_LABELS[section] ?? section}
                    </button>
                  );
                })}
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#718096]" />
                <Input
                  value={fieldSearch}
                  onChange={(e) => setFieldSearch(e.target.value)}
                  placeholder="Search fields"
                  className="pl-8 h-9 bg-[#0D1117] border-[rgba(255,255,255,0.08)] text-[13px] text-[#E1E7EF]"
                />
              </div>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-1.5">
                <div className="sticky top-0 z-10 -mx-1 px-1 pb-2 bg-[#171D26] text-[10px] font-bold uppercase tracking-[0.14em] text-[#718096]">
                  {selectedSection}
                </div>
                    {selectedSectionGroups.map(({ section, group }) => {
                      const key = groupKey(section, group);
                      const Icon = categoryIcon(group);
                      const groupFields = filterFields.filter((f) => f.section === section && f.group === group);
                      if (groupFields.length === 0) return null;

                      const isActive = selectedGroup === key;
                      const matchesSearch = visibleGroups.some((item) => groupKey(item.section, item.group) === key);

                      return (
                        <button
                          key={key}
                          onClick={() => setSelectedGroup(key)}
                          className={[
                            'w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl text-left transition-all duration-150 border',
                            isActive
                              ? 'bg-[rgba(220,38,38,0.10)] border-[rgba(220,38,38,0.24)] text-[#E1E7EF] shadow-[0_0_0_1px_rgba(220,38,38,0.04)]'
                              : 'bg-[#0D1117] border-[rgba(255,255,255,0.06)] text-[#A0AEC0] hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.12)]',
                            matchesSearch ? '' : 'opacity-40',
                          ].join(' ')}
                        >
                          <span className="flex min-w-0 items-center gap-3">
                            <Icon className="h-4 w-4 shrink-0 text-green-300" />
                            <span className="min-w-0 text-[13px] font-medium leading-tight">{group}</span>
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] text-[#A7B1C2]">
                            {groupFields.length}
                          </span>
                        </button>
                      );
                    })}
              </div>

              {selectedSectionGroups.length === 0 && (
                <div className="py-8 text-center text-[12px] text-[#586174]">
                  No groups match this session.
                </div>
              )}
            </div>
          </aside>

          <div className="p-5 bg-transparent overflow-hidden flex flex-col min-h-0">
            <div className="flex items-start justify-between gap-4 mb-4 shrink-0">
              <div>
                <h3 className="text-[14px] font-semibold text-[#E1E7EF] tracking-tight">{selectedGroupInfo.group}</h3>
                <p className="text-[11px] text-[#708096] mt-1">
                  {selectedGroupInfo.section} · {CATEGORY_HINTS[selectedGroupInfo.group] ?? 'Pick a field to continue'}
                </p>
              </div>
              {selectedField && (
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-[#708096]">Selected</div>
                  <div className="text-[13px] font-medium text-green-400">{selectedField.label}</div>
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div
                className="grid gap-1.5 justify-start"
                style={{
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 210px))',
                }}
              >
                {currentFields.map((field) => {
                  const active = newFilterField === field.value;
                  return (
                    <button
                      key={field.value}
                      onClick={() => handlePickField(field)}
                      className={[
                        'min-h-[36px] px-3 py-1.5 rounded-lg text-[11.5px] font-medium leading-tight transition-all duration-150 border',
                        active
                          ? 'bg-[rgba(22,101,52,0.28)] border-[rgba(21,128,61,0.65)] text-green-200 shadow-[0_0_0_1px_rgba(34,197,94,0.16)]'
                          : 'bg-[#1A222D] border-[rgba(255,255,255,0.04)] text-green-300 hover:bg-[#202A36] hover:border-[rgba(34,197,94,0.35)]',
                      ].join(' ')}
                    >
                      <span className="block text-center">{field.label}</span>
                    </button>
                  );
                })}
              </div>

              {currentFields.length === 0 && (
                <div className="mt-8 text-center text-[12px] text-[#586174]">
                  No fields match this category and search.
                </div>
              )}
            </div>

            {!selectionOnly && <div className="mt-4 grid grid-cols-1 lg:grid-cols-[180px_minmax(0,1fr)] gap-4 border-t border-[rgba(255,255,255,0.08)] pt-4 shrink-0">
              <div className="space-y-2">
                <Label className="text-[11px] text-[#A0AEC0] font-medium">Operator</Label>
                <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                  {(['=', '!=', '>', '>=', '<', '<='] as const).map((op) => {
                    const active = newFilterOperator === op;
                    return (
                      <button
                        key={op}
                        type="button"
                        onClick={() => setNewFilterOperator(op)}
                        className={[
                          'w-full rounded-lg px-3 py-2 text-[12px] font-semibold transition-all duration-150',
                          active
                            ? 'bg-[rgba(22,101,52,0.30)] text-green-200 shadow-[0_0_0_1px_rgba(21,128,61,0.35)]'
                            : 'text-[#8F9BB0] hover:text-[#E1E7EF] hover:bg-[rgba(255,255,255,0.04)]',
                        ].join(' ')}
                      >
                          {op}
                        </button>
                      );
                    })}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-[11px] text-[#A0AEC0] font-medium">Value</Label>
                <div className="inline-flex w-full rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                  {(['static', 'field'] as const).map((mode) => {
                    const active = valueMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          setValueMode(mode);
                          if (mode === 'static') {
                            setCompareField('');
                          } else {
                            setNewFilterValue('');
                          }
                        }}
                        className={[
                          'flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition-all duration-150',
                          active
                            ? 'bg-[rgba(22,101,52,0.30)] text-green-200 shadow-[0_0_0_1px_rgba(21,128,61,0.35)]'
                            : 'text-[#8F9BB0] hover:text-[#E1E7EF] hover:bg-[rgba(255,255,255,0.04)]',
                        ].join(' ')}
                      >
                        {mode === 'static' ? 'Static Value' : 'Other Variable'}
                      </button>
                    );
                  })}
                </div>

                {valueMode === 'static' && (
                  <div className="relative">
                    {selectedField?.value === 'change_pct' && (
                      <div className="mb-2 flex items-center gap-2">
                        <Label className="whitespace-nowrap text-[11px] text-[#A0AEC0] font-medium">Period</Label>
                        <Input
                          type="number"
                          min={1}
                          max={5000}
                          step={1}
                          value={lookbackDays}
                          onChange={(event) => setLookbackDays(event.target.value)}
                          className="h-9 w-28 bg-[#0D1117] border-[rgba(255,255,255,0.08)] rounded-lg text-[#E1E7EF] text-[12px]"
                        />
                        <span className="text-[11px] text-[#708096]">trading days</span>
                      </div>
                    )}
                    {selectedField?.type === 'boolean' ? (
                      <select
                        id="value"
                        value={newFilterValue}
                        onChange={(e) => setNewFilterValue(e.target.value)}
                        className="h-12 w-full rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-3 text-[13px] text-[#E1E7EF] focus:border-[rgba(34,197,94,0.55)] focus:outline-none focus:ring-1 focus:ring-[rgba(34,197,94,0.24)]"
                      >
                        <option value="">Choose a value</option>
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    ) : (
                      <Input
                        id="value"
                        type={selectedField?.type === 'numeric' || !selectedField ? 'number' : 'text'}
                        placeholder={selectedField?.type === 'numeric' ? 'Enter numeric value' : 'Enter text value'}
                        value={newFilterValue}
                        onChange={(e) => setNewFilterValue(e.target.value)}
                        className={`h-12 bg-[#0D1117] border-[rgba(255,255,255,0.08)] rounded-xl text-[#E1E7EF] text-[13px] placeholder:text-[#586174] shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] focus:border-[rgba(34,197,94,0.55)] focus:ring-[rgba(34,197,94,0.24)] ${
                          valueSuffix ? 'pr-10' : ''
                        }`}
                      />
                    )}
                    {valueSuffix && (
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-[#708096]">
                        {valueSuffix}
                      </span>
                    )}
                  </div>
                )}

                {valueMode === 'field' && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label className="text-[11px] text-[#A0AEC0] font-medium">Other variable</Label>
                      <Input
                        value={compareSearch}
                        onChange={(e) => setCompareSearch(e.target.value)}
                        placeholder="Search variables"
                        className="h-10 bg-[#0D1117] border-[rgba(255,255,255,0.08)] rounded-xl text-[#E1E7EF] text-[13px] placeholder:text-[#586174]"
                      />
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {FIELD_GROUPS.map(({ section, group }) => {
                        const key = groupKey(section, group);
                        const groupFields = filterFields.filter((f) => f.type === 'numeric' && f.section === section && f.group === group && f.value !== newFilterField);
                        if (groupFields.length === 0) return null;
                        const isActive = compareGroup === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setCompareGroup(key)}
                            className={[
                              'px-2.5 py-1.5 rounded-lg text-[10px] font-semibold border transition-all duration-150',
                              isActive
                                ? 'bg-[rgba(22,101,52,0.28)] border-[rgba(21,128,61,0.55)] text-green-100'
                                : 'bg-[#0D1117] border-[rgba(255,255,255,0.06)] text-[#A0AEC0] hover:bg-[rgba(255,255,255,0.03)]',
                            ].join(' ')}
                          >
                            {section} · {group}
                          </button>
                        );
                      })}
                    </div>

                    <div
                      className="grid gap-1.5 justify-start max-h-[210px] overflow-y-auto pr-1"
                      style={{
                        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 210px))',
                      }}
                    >
                      {compareFields.map((field) => {
                        const active = compareField === field.value;
                        return (
                          <button
                            key={field.value}
                            type="button"
                            onClick={() => setCompareField(field.value)}
                            className={[
                              'min-h-[34px] px-3 py-1.5 rounded-lg text-[11.5px] font-medium leading-tight transition-all duration-150 border',
                              active
                                ? 'bg-[rgba(220,38,38,0.12)] border-[rgba(220,38,38,0.28)] text-[#F87171] shadow-[0_0_0_1px_rgba(220,38,38,0.06)]'
                                : 'bg-[#1A222D] border-[rgba(255,255,255,0.04)] text-green-300 hover:bg-[#202A36] hover:border-[rgba(34,197,94,0.35)]',
                            ].join(' ')}
                          >
                            <span className="block text-center">{field.label}</span>
                          </button>
                        );
                      })}
                    </div>

                  </div>
                )}
              </div>
            </div>}
          </div>
        </div>

        <DialogFooter className="px-5 py-4 border-t border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] shrink-0">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="bg-[#0D1117] border-[rgba(255,255,255,0.08)] text-[#A0AEC0] hover:bg-[rgba(255,255,255,0.04)]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleAddFilter}
            disabled={selectionOnly ? !newFilterField : !newFilterField || (valueMode === 'static' ? !newFilterValue : !compareField)}
            className="bg-gradient-to-r from-[#166534] to-[#15803D] text-white hover:shadow-lg hover:shadow-[#15803D]/30 disabled:opacity-40"
          >
            {selectionOnly ? 'Select field' : editingFilter ? 'Save changes' : 'Add Filter'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getValueSuffix(field: FilterField | null): string {
  if (!field) return '';
  if (field.unit === 'volume') return 'M';
  if (field.unit === 'percent') return '%';
  if (field.unit === 'price') return '$';
  return '';
}
