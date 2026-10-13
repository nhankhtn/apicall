// Detects a newer deployment by comparing the entry script of the served index.html.
const scriptPattern = /<script type="module"[^>]*\ssrc="([^"]+)"/;

export const buildScriptSrc = (html) => html.match(scriptPattern)?.[1] ?? null;

export async function newerBuildReady() {
  const current = document.querySelector('script[type="module"]')?.getAttribute('src');
  if (!current) return false;
  const response = await fetch(window.location.href, { cache: 'no-cache' });
  if (!response.ok) return false;
  const next = buildScriptSrc(await response.text());
  return next !== null && next !== current;
}
