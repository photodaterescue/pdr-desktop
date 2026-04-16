import { createRoot } from 'react-dom/client';
import PeopleManager from './components/PeopleManager';
import './index.css';

// Apply dark mode if the query param says so
const params = new URLSearchParams(window.location.search);
if (params.get('dark') === '1') {
  document.documentElement.classList.add('dark');
}

// Listen for theme changes from the main window
if ((window as any).pdr?.people?.onThemeChange) {
  (window as any).pdr.people.onThemeChange((isDark: boolean) => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  });
}

createRoot(document.getElementById('people-root')!).render(
  <PeopleManager />
);
