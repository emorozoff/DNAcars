import { Application, Container, Graphics } from 'pixi.js';

export type StageHandle = {
  app: Application;
  world: Container;
  destroy: () => void;
};

/**
 * Mounts a Pixi v8 application into the given host element.
 * The placeholder renders a single horizontal track line and a centered dot,
 * just to confirm rendering is alive. Real scene comes in week 1.
 */
export async function mountStage(host: HTMLElement): Promise<StageHandle> {
  const app = new Application();

  const surfaceColor = readCssColor('--color-bg', 0x0e0e10);
  const trackColor = readCssColor('--color-track', 0x2a2a31);
  const accentColor = readCssColor('--color-accent', 0xa8ff60);

  await app.init({
    background: surfaceColor,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    resizeTo: host,
  });

  host.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  const placeholder = new Graphics();
  redraw();
  world.addChild(placeholder);

  const onResize = (): void => redraw();
  const ro = new ResizeObserver(onResize);
  ro.observe(host);

  function redraw(): void {
    const w = app.renderer.width / (window.devicePixelRatio || 1);
    const h = app.renderer.height / (window.devicePixelRatio || 1);
    placeholder.clear();
    placeholder
      .moveTo(0, h * 0.65)
      .lineTo(w, h * 0.65)
      .stroke({ color: trackColor, width: 2 });
    placeholder.circle(w * 0.5, h * 0.65 - 20, 12).fill(accentColor);
  }

  return {
    app,
    world,
    destroy(): void {
      ro.disconnect();
      app.destroy(true, { children: true });
    },
  };
}

function readCssColor(varName: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!value) return fallback;
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const c0 = hex[0] ?? '0';
      const c1 = hex[1] ?? '0';
      const c2 = hex[2] ?? '0';
      const r = parseInt(c0 + c0, 16);
      const g = parseInt(c1 + c1, 16);
      const b = parseInt(c2 + c2, 16);
      return (r << 16) | (g << 8) | b;
    }
    if (hex.length === 6) return parseInt(hex, 16);
  }
  return fallback;
}
