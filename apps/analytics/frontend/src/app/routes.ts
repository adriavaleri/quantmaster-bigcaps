import { createHashRouter, redirect } from 'react-router';
import Root from './Root';
import Overview from '../features/overview/Overview';
import Charts from '../features/charts/Charts';
import DataExplorer from '../features/data-explorer/DataExplorer';
import Exports from '../features/exports/Exports';

// Hash routing keeps the original Analytics pages working in the desktop shell.
export const router = createHashRouter([
  {
    path: '/',
    Component: Root,
    children: [
      { index: true, Component: Overview },
      { path: 'charts', Component: Charts },
      { path: 'data-explorer', Component: DataExplorer },
      { path: 'exports', Component: Exports },
      { path: 'daily', loader: () => redirect('/') },
    ],
  },
]);
