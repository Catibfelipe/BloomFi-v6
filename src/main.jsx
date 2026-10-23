import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './store.jsx';
import App from './App.jsx';
import { AppBoundary } from './components/ErrorBoundary.jsx';
import { initSW } from './lib/sw.js';
import './lib/pwa.js';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <AppBoundary>
    <StoreProvider>
      <App />
    </StoreProvider>
  </AppBoundary>
);

if (import.meta.env.VITE_ARTIFACT === '1') document.documentElement.classList.add('artifact-mode');
else initSW();
