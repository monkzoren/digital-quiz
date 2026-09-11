// Stale-page notice: every build bakes __BUILD_ID__ into the bundle and ships
// the same id in /version.json (vite.config.ts). We re-fetch that file
// periodically and on tab focus, and offer a refresh when it changes. Never a
// forced reload — a banner mid-quiz is rude enough already.
declare const __BUILD_ID__: string;

const POLL_MS = 5 * 60_000;
let newBuildSeen = false;

function showBanner(text: string, actionLabel: string, onClick: () => void) {
  if (document.getElementById('update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99;display:flex;align-items:center;' +
    'justify-content:center;gap:1em;padding:.45em 1em;background:var(--wood-hi);' +
    'color:var(--ink);font-family:var(--font),Arial,sans-serif;font-size:14px;';
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = `${text} — ${actionLabel}`;
  link.style.cssText = 'color:var(--gold);font-weight:bold;';
  link.onclick = e => { e.preventDefault(); onClick(); };
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss');
  close.style.cssText = 'background:none;border:none;color:var(--ink);cursor:pointer;font-size:18px;line-height:1;padding:0 .3em;box-shadow:none;';
  close.onclick = () => bar.remove();
  bar.append(link, close);
  document.body.append(bar);
}

async function checkBuild() {
  if (newBuildSeen) return;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { buildId } = await res.json();
    if (buildId && buildId !== __BUILD_ID__) {
      newBuildSeen = true;
      showBanner('A new version of Digital Quiz is live', 'REFRESH', () => location.reload());
    }
  } catch {
    // offline / server restarting — the next tick will try again
  }
}

if (!(import.meta as any).env?.DEV) {
  setInterval(checkBuild, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkBuild();
  });
}
