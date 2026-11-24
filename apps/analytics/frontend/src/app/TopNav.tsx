import { Link, useLocation } from 'react-router';
import {
  Database,
  FileText,
  Search,
  Settings,
  TrendingUp,
  User,
} from 'lucide-react';
import appLogo from '../shared/assets/app-logo.png';

const navItems = [
  { path: '/', label: 'Overview', icon: TrendingUp },
  { path: '/charts', label: 'Charts', icon: Database },
  { path: '/data-explorer', label: 'Data Explorer', icon: Search },
  { path: '/exports', label: 'Exports', icon: FileText },
];

export default function TopNav({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const location = useLocation();
  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/' || location.pathname === '/daily';
    return location.pathname.startsWith(path);
  };

  return (
    <header className="sticky top-0 z-50 border-b border-[#2B2E34] bg-[#181B21] shadow-lg">
      <div className="mx-auto max-w-[1800px] px-6 py-4">
        <div className="flex items-center justify-between gap-6">
          <div className="flex w-fit shrink-0 items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left">
            <img
              src={appLogo}
              alt=""
              className="analytics-logo-red h-10 w-10 shrink-0 rounded-lg object-cover drop-shadow-[0_0_8px_rgba(220,38,38,0.18)]"
            />
            <span className="whitespace-nowrap text-2xl font-bold leading-tight text-[#E9EEF5]">BigCaps</span>
          </div>

          <div className="min-w-0 flex-1">
            <nav className="flex h-11 w-full items-center gap-2 rounded-xl border border-[#2B2E34] bg-[#0F1115] px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.path);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-5 py-2 text-[13px] font-semibold transition-all duration-200 ${
                      active
                        ? 'bg-[linear-gradient(135deg,#F87171_0%,#DC2626_72%,#B91C1C_100%)] text-white shadow-[0_10px_22px_rgba(220,38,38,0.22)]'
                        : 'text-[#9AA7B8] hover:bg-white/[.04] hover:text-[#E8EDF5]'
                    }`}
                  >
                    <Icon className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#2B2E34] bg-[#0F1115] transition-all duration-200 hover:border-[#7F1D1D] hover:bg-[#151a22]"
              aria-label="Open settings"
            >
              <Settings className="h-4 w-4 text-[#A8B4C7]" strokeWidth={2} />
            </button>
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#DC2626] bg-[linear-gradient(135deg,#F87171_0%,#DC2626_100%)] shadow-[0_8px_18px_rgba(220,38,38,0.22)]"
              aria-label="User profile"
            >
              <User className="h-4 w-4 text-white" strokeWidth={2.1} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
