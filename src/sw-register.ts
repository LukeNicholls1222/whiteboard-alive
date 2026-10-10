// Registers the service worker (public/sw.js) so a page that was opened online once keeps working after a
// reload when the venue Wi-Fi drops.
//
// - Relative 'sw.js': the page lives under /whiteboard-alive/, so that is the scope.
// - Not on localhost (keeps Vite HMR intact) unless the URL has ?sw=1 (e.g. `vite preview`).
// - ?sw=0 unregisters and clears the caches on this device, and keeps the worker off while the URL has it.
// - Registration waits for window load so it does not compete with the 10 MB opencv.js download.
// - First install: a small "Ready to work offline" toast for 2 s. Updates are silent and never reload the page.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const swParam = new URLSearchParams(location.search).get('sw');
const isLocal = LOCAL_HOSTS.includes(location.hostname);

if ('serviceWorker' in navigator) {
  if (swParam === '0') {
    disable().catch((err) => console.warn('[sw] could not disable', err));
  } else if (!isLocal || swParam === '1') {
    whenLoaded().then(enable);
  }
}

async function enable() {
  const hadController = !!navigator.serviceWorker.controller;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const worker = reg.active;
    if (worker) await activated(worker);
    console.log(`[sw] ${hadController ? 'active' : 'installed'} (${reg.scope})`);
    if (!hadController) toast('Ready to work offline');
  } catch (err) {
    console.warn('[sw] registration failed', err);
  }
}

async function disable() {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith('whiteboard-alive-')).map((n) => caches.delete(n)));
  console.log(`[sw] removed ${regs.length} registration(s), ${names.length} cache(s)`);
  toast('Offline cache cleared');
}

function whenLoaded(): Promise<void> {
  return document.readyState === 'complete'
    ? Promise.resolve()
    : new Promise((r) => window.addEventListener('load', () => r(), { once: true }));
}

function activated(worker: ServiceWorker): Promise<void> {
  return worker.state === 'activated'
    ? Promise.resolve()
    : new Promise((r) => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated' || worker.state === 'redundant') r();
        });
      });
}

/** Small pill at the bottom of the screen, shown for 2 s. */
function toast(text: string) {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.textContent = text;
  Object.assign(el.style, {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(20px + env(safe-area-inset-bottom))',
    transform: 'translate(-50%, 12px)',
    opacity: '0',
    padding: '10px 18px',
    borderRadius: '999px',
    background: '#1f2937',
    color: '#fff',
    font: '700 14px/1.2 Nunito, system-ui, sans-serif',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
    transition: 'opacity 250ms ease, transform 250ms ease',
    pointerEvents: 'none',
    zIndex: '1000',
    whiteSpace: 'nowrap',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%, 0)';
  });
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%, 12px)';
    setTimeout(() => el.remove(), 300);
  }, 2000);
}
