import { useEffect, useRef, useState } from 'react';

// "Install" in the top bar: installs the app as a standalone window (PWA). index.html keeps the
// browser's beforeinstallprompt event in window.__apicallInstallPrompt; hidden once installed or
// when the browser cannot install (needs Chrome/Edge and https or localhost).
const runningAsApp = () => window.matchMedia('(display-mode: standalone)').matches;

export default function InstallButton() {
  const promptRef = useRef(window.__apicallInstallPrompt ?? null);
  const waitingRef = useRef(false);
  const [installed, setInstalled] = useState(runningAsApp);

  async function run(prompt) {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    promptRef.current = null;
    window.__apicallInstallPrompt = null;
    if (choice.outcome === 'accepted') setInstalled(true);
  }

  useEffect(() => {
    const onReady = () => {
      const prompt = window.__apicallInstallPrompt ?? null;
      promptRef.current = prompt;
      if (prompt && waitingRef.current) {
        waitingRef.current = false;
        run(prompt);
      }
    };
    const onInstalled = () => {
      promptRef.current = null;
      window.__apicallInstallPrompt = null;
      waitingRef.current = false;
      setInstalled(true);
    };
    window.addEventListener('apicall-install', onReady);
    window.addEventListener('appinstalled', onInstalled);
    onReady();
    return () => {
      window.removeEventListener('apicall-install', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || !('onbeforeinstallprompt' in window)) return null;

  return (
    <button
      className="topbar-btn install"
      type="button"
      aria-label="Install app"
      title="Install ApiCall Runner as an app"
      onClick={() => {
        const prompt = promptRef.current;
        if (!prompt) {
          waitingRef.current = true;
          return;
        }
        run(prompt);
      }}
    >
      <svg className="topbar-glyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2.4v6.2M5.5 6.3 8 8.8l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3.2 10.2h9.6v2.4a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <span>Install</span>
    </button>
  );
}
