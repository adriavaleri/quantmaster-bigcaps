import { useEffect, useState } from 'react';
import { Bookmark, Check, ChevronDown, Pencil, Save, Trash2, X } from 'lucide-react';
import { useFilters, type DateRangePreset } from './FilterContext';
import { Badge } from '../../shared/components/ui/badge';
import { Button } from '../../shared/components/ui/button';
import { Input } from '../../shared/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../shared/components/ui/popover';
import { ScrollArea } from '../../shared/components/ui/scroll-area';

interface SavedFiltersPopoverProps {
  triggerClassName?: string;
  triggerLabel?: string;
  fullWidthTrigger?: boolean;
}

export default function SavedFiltersPopover({
  triggerClassName,
  triggerLabel = 'Saved Filters',
  fullWidthTrigger = false,
}: SavedFiltersPopoverProps) {
  const {
    filters,
    dateRange,
    customDateStart,
    customDateEnd,
    savedFilterSets,
    saveCurrentFilterSet,
    renameSavedFilterSet,
    loadSavedFilterSet,
    deleteSavedFilterSet,
  } = useFilters();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  useEffect(() => {
    if (open) {
      setName('');
      setEditingId(null);
      setEditingName('');
    }
  }, [open]);

  const handleSave = () => {
    saveCurrentFilterSet(name);
    setOpen(false);
  };

  const handleLoad = (id: string) => {
    loadSavedFilterSet(id);
    setOpen(false);
  };

  const startEditing = (id: string, currentName: string) => {
    setEditingId(id);
    setEditingName(currentName);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingName('');
  };

  const commitRename = (id: string) => {
    renameSavedFilterSet(id, editingName);
    cancelEditing();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={[
            fullWidthTrigger ? 'w-full justify-between' : '',
            'border-[rgba(220,38,38,0.30)] text-[#DC2626] hover:border-[rgba(220,38,38,0.48)] hover:bg-[rgba(220,38,38,0.08)]',
            triggerClassName ?? '',
          ].join(' ')}
        >
          <span className="inline-flex items-center gap-1.5">
            <Bookmark className="w-3.5 h-3.5" />
            {triggerLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Badge className="bg-[rgba(220,38,38,0.12)] text-[#DC2626] border border-[rgba(220,38,38,0.22)] px-1.5 py-0 text-[10px] font-mono">
              {savedFilterSets.length}
            </Badge>
            <ChevronDown className="w-3.5 h-3.5 opacity-60" />
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={10}
        className="w-[420px] p-0 overflow-hidden bg-gradient-to-br from-[#151B23] via-[#131821] to-[#0F141B] border border-[rgba(255,255,255,0.08)] shadow-2xl text-[#E1E7EF]"
      >
        <div className="px-4 py-3 border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)]">
          <div className="flex items-start justify-between gap-3">
            <div className="text-[14px] font-semibold tracking-tight">Saved filters</div>
          </div>
        </div>

        <div className="p-4 space-y-4">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[#718096]">
                Save current
              </div>
            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder=""
                className="h-10 bg-[#0D1117] border-[rgba(255,255,255,0.08)] text-[13px] text-[#E1E7EF] placeholder:text-[#586174]"
              />
              <Button
                type="button"
                onClick={handleSave}
                disabled={!name.trim()}
                className="h-10 shrink-0 bg-gradient-to-r from-[#166534] to-[#15803D] text-white hover:shadow-lg hover:shadow-[#15803D]/25"
              >
                <Save className="w-3.5 h-3.5 mr-1.5" />
                Save
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#718096]">
              Load saved
            </div>
            {savedFilterSets.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-4 py-5 text-center">
                <div className="text-[12px] text-[#A7B1C2] font-medium">No saved filter sets yet</div>
                <div className="text-[11px] text-[#586174] mt-1">
                  Save the current filters to create a fast reusable setup.
                </div>
              </div>
            ) : (
              <ScrollArea className="max-h-[280px] pr-2">
                <div className="space-y-2">
                  {savedFilterSets.map((set) => (
                    <div
                      key={set.id}
                      onClick={() => {
                        if (editingId !== set.id) handleLoad(set.id);
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (editingId === set.id) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleLoad(set.id);
                        }
                      }}
                      className="group w-full rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-3 py-2.5 text-left transition-all duration-150 hover:border-[rgba(34,197,94,0.45)] hover:bg-[rgba(22,101,52,0.16)] cursor-pointer"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          {editingId === set.id ? (
                            <div
                              className="space-y-2"
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              <Input
                                autoFocus
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                className="h-9 bg-[#0D1117] border-[rgba(34,197,94,0.35)] text-[13px] text-[#E1E7EF]"
                              />
                              <div className="flex items-center gap-1.5">
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    commitRename(set.id);
                                  }}
                                  disabled={!editingName.trim()}
                                  className="h-8 bg-gradient-to-r from-[#166534] to-[#15803D] text-white"
                                >
                                  <Check className="w-3.5 h-3.5 mr-1" />
                                  Save
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    cancelEditing();
                                  }}
                                  className="h-8 border-[rgba(255,255,255,0.08)] bg-[#0D1117] text-[#A7B1C2] hover:bg-[rgba(255,255,255,0.04)]"
                                >
                                  <X className="w-3.5 h-3.5 mr-1" />
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-2 min-w-0">
                                <Bookmark className="w-3.5 h-3.5 text-[#DC2626] shrink-0" />
                                <span className="text-[13px] font-semibold text-[#E1E7EF] truncate">
                                  {set.name}
                                </span>
                                <Badge className="ml-auto bg-[rgba(255,255,255,0.04)] text-[#A7B1C2] border border-[rgba(255,255,255,0.08)] px-1.5 py-0 text-[10px] font-mono">
                                  {set.filters.length}
                                </Badge>
                              </div>
                              <div className="mt-1 text-[11px] text-[#8F9BB0] truncate">
                                {formatSavedMeta(set)}
                              </div>
                              <div className="mt-1 text-[10px] text-[#586174] truncate">
                                {previewFilters(set.filters)}
                              </div>
                            </>
                          )}
                        </div>

                        <div className="shrink-0 flex items-start gap-1">
                          {editingId !== set.id && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                startEditing(set.id, set.name);
                              }}
                              className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] p-2 text-[#A7B1C2] opacity-70 transition-all duration-150 hover:opacity-100 hover:bg-[rgba(255,255,255,0.08)]"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              deleteSavedFilterSet(set.id);
                            }}
                            className="rounded-lg border border-[rgba(239,68,68,0.18)] bg-[rgba(239,68,68,0.06)] p-2 text-[#FCA5A5] opacity-70 transition-all duration-150 hover:opacity-100 hover:bg-[rgba(239,68,68,0.12)]"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatDateRange(
  dateRange: DateRangePreset,
  customDateStart: string | null,
  customDateEnd: string | null,
): string {
  switch (dateRange) {
    case 'last-year':
      return 'Last 12M';
    case 'last-month':
      return 'Last 30D';
    case 'last-7-days':
      return 'Last 7D';
    case 'custom':
      return customDateStart && customDateEnd
        ? `${customDateStart} → ${customDateEnd}`
        : 'Custom range';
    default:
      return 'All time';
  }
}

function formatSavedMeta(set: {
  dateRange: DateRangePreset;
  customDateStart: string | null;
  customDateEnd: string | null;
}): string {
  return formatDateRange(set.dateRange, set.customDateStart, set.customDateEnd);
}

function previewFilters(filters: { label: string }[]): string {
  if (filters.length === 0) return 'No filters';
  if (filters.length === 1) return filters[0].label;
  return `${filters[0].label} · ${filters[1].label}${filters.length > 2 ? ` · +${filters.length - 2} more` : ''}`;
}
