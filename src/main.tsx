import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { installAndroidInsets } from './ui/androidInsets';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}

// Before the first paint: the top bar and the palette are laid out against
// these, and on Android they are zero until the activity is asked for them.
installAndroidInsets();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
