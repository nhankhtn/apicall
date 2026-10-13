import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { newerBuildReady } from './appUpdate.js';
import './styles.css';

// Service worker (makes the app installable) and reload-on-new-deployment, production only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  let reloading = false;
  const reload = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  const watchForUpdate = () => newerBuildReady().then((newer) => newer && reload(), () => {});
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update();
          watchForUpdate();
        }
      });
      setInterval(() => {
        registration.update();
        watchForUpdate();
      }, 10 * 60 * 1000);
    });
  });
  if (navigator.serviceWorker.controller) navigator.serviceWorker.addEventListener('controllerchange', reload);
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
