import { createRoot } from 'react-dom/client';
import { App, type Surface } from './App';
import { branding } from '../branding';
import './style.css';

export function mount(surface: Surface) {
  document.title = `${branding.name} · ${surface}`;
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing UI root');
  createRoot(root).render(<App surface={surface} />);
}
