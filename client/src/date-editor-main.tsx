import { createRoot } from 'react-dom/client';
import DateEditor from './components/DateEditor';
import { LicenseProvider } from './contexts/LicenseContext';
import './index.css';

// Apply dark mode from query param
const params = new URLSearchParams(window.location.search);
if (params.get('dark') === '1') {
  document.documentElement.classList.add('dark');
}

// Listen for theme changes from the main window (reuses the People theme channel).
if ((window as any).pdr?.dateEditor?.onThemeChange) {
  (window as any).pdr.dateEditor.onThemeChange((isDark: boolean) => {
    if (isDark) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  });
}

createRoot(document.getElementById('date-editor-root')!).render(
  <LicenseProvider>
    <DateEditor />
  </LicenseProvider>
);
