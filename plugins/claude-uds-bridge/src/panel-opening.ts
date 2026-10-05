import { spawn } from 'node:child_process';

// This requests navigation in the local default browser, never changes reception.
// Headless clients and tests explicitly disable it. A successful dispatch is not
// evidence that a human saw the page.
export class PanelOpening {
  private opened = new Map<string, Promise<{requested: boolean; error?: string}>>();
  constructor(private launch = launchLocalBrowser) {}
  open(key: string, url: string, enabled = true, force = false) {
    if (!enabled || process.env.CC_CDX_PANEL_AUTO_OPEN === '0') return Promise.resolve({requested: false});
    const previous = this.opened.get(key); if (previous && !force) return previous;
    const pending = this.launch(url).then(() => ({requested: true}), () => ({requested: false, error: 'No se pudo abrir el navegador. Abre el enlace privado del panel.'}));
    this.opened.set(key, pending); return pending;
  }
}
function launchLocalBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('Only the private local panel can be opened');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'xdg-open' : null;
  if (!command) return Promise.reject(new Error('No desktop browser launcher available'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, [url], {stdio: 'ignore'});
    const timer = setTimeout(() => {child.kill(); reject(new Error('Browser launch timed out'));}, 3000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', code => {clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Browser launch failed'));});
  });
}

export function panelLink(url: string, target: {runId?: string; authorization?: boolean} = {}) {
  const link = new URL(url), hash = new URLSearchParams(link.hash.slice(1));
  if (target.runId) hash.set('run', target.runId);
  if (target.authorization) hash.set('view', 'authorization');
  link.hash = hash.toString(); return link.toString();
}
