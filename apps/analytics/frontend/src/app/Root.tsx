import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import TopNav from './TopNav';
import { FilterProvider } from '../features/filters/FilterContext';
import { SettingsPanel } from './SettingsPanel';

const DATA_ROOT_KEY = 'qmdata.daily-analytics-root';
const DEFAULT_DATA_ROOT = 'C:\\BigCaps\\data';


function initialDataRoot(): string {
  if (typeof window === 'undefined') return DEFAULT_DATA_ROOT;
  return window.localStorage.getItem(DATA_ROOT_KEY) || DEFAULT_DATA_ROOT;
}

export default function Root() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dataRoot, setDataRoot] = useState(initialDataRoot);
  const [datasetRevision, setDatasetRevision] = useState(0);

  useEffect(() => {
    window.localStorage.setItem(DATA_ROOT_KEY, dataRoot);
  }, [dataRoot]);

  return (
    <FilterProvider>
      <div className="min-h-screen bg-[#0a0e1a] text-gray-100 flex flex-col">
        <TopNav
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <main className="flex-1 overflow-y-auto">
          <Outlet key={`${dataRoot}:${datasetRevision}`} context={{ dataRoot }} />
        </main>
        <SettingsPanel
          open={settingsOpen}
          dataRoot={dataRoot}
          onSave={setDataRoot}
          onUpdated={(root) => {
            setDataRoot(root);
            setDatasetRevision((revision) => revision + 1);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    </FilterProvider>
  );
}
