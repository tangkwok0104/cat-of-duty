import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';

/** Floating name-tag sprites for ground pickups (playtest ask: "the objects
 *  on the floor — I never know what those are"). Same canvas-sprite recipe
 *  as enemies/CatOverlays' HP bars / damage numbers (CanvasTexture +
 *  SpriteMaterial, transparent, depthWrite false, SRGB, no mipmaps) so a
 *  label always billboards toward the camera for free. Icons are drawn on
 *  the same canvas above the text — callers only ever see one Sprite. */

const CANVAS_W = 256;
const CANVAS_H = 96;
const WORLD_W = 0.55;
const WORLD_H = (CANVAS_H / CANVAS_W) * WORLD_W; // keep the sprite's aspect == canvas aspect

const STROKE = 'rgba(11, 13, 9, 0.85)'; // dark halo so text reads over bright fur/floor
const FONT = 'bold 32px "SF Mono", ui-monospace, "Cascadia Mono", Menlo, monospace';
const ICON_Y = 24; // canvas px, icon band sits above the text when one is drawn
/** Text baseline when an icon occupies the top of the canvas (health/ammo/
 *  station). Guns pass no icon — their text centers on the full canvas
 *  instead, since the GLB silhouette below is the only "icon" they get. */
const TEXT_Y_WITH_ICON = 74;
const TEXT_Y_NO_ICON = CANVAS_H / 2;
const LINE_GAP = 22; // canvas px between stacked lines, for the rare 2-line label

export type IconDrawer = (ctx: CanvasRenderingContext2D, cx: number, cy: number) => void;

export interface PickupLabelHandle {
  sprite: Sprite;
  material: SpriteMaterial;
  texture: CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Redraw this label's canvas in place (pool reuse on eviction/respawn —
   *  never leave a stale kind's text showing under a new pickup). */
  draw: (lines: readonly string[], color: string, icon?: IconDrawer) => void;
}

/** Thick plus-sign: health. */
export const drawHealthIcon: IconDrawer = (ctx, cx, cy) => {
  const arm = 16;
  const w = 6;
  ctx.fillStyle = '#9ee493';
  ctx.fillRect(cx - w / 2, cy - arm, w, arm * 2);
  ctx.fillRect(cx - arm, cy - w / 2, arm * 2, w);
};

/** Three vertical bullet bars: ammo. */
export const drawAmmoIcon: IconDrawer = (ctx, cx, cy) => {
  ctx.fillStyle = '#ffb02e';
  const barW = 7;
  const gap = 5;
  const heights = [14, 20, 14];
  for (let i = 0; i < 3; i++) {
    const h = heights[i] ?? 14;
    const x = cx - barW * 1.5 - gap + i * (barW + gap);
    ctx.fillRect(x, cy - h / 2, barW, h);
  }
};

/** Crate outline: ammo station. */
export const drawCrateIcon: IconDrawer = (ctx, cx, cy) => {
  ctx.strokeStyle = '#ffb02e';
  ctx.lineWidth = 3;
  const half = 15;
  ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
  ctx.beginPath();
  ctx.moveTo(cx - half, cy);
  ctx.lineTo(cx + half, cy);
  ctx.moveTo(cx, cy - half);
  ctx.lineTo(cx, cy + half);
  ctx.stroke();
};

/** Builds one label Sprite. Pass `lines`/`color`/`icon` up front to paint it
 *  immediately, or call `.draw(...)` later (pool reuse). `sprite.visible`
 *  starts false — callers control when a label shows. */
export function buildPickupLabel(
  lines: readonly string[],
  color: string,
  icon?: IconDrawer,
): PickupLabelHandle {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PickupLabel: 2D canvas context unavailable');

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const sprite = new Sprite(material);
  sprite.visible = false;
  sprite.scale.set(WORLD_W, WORLD_H, 1);

  const draw = (drawLines: readonly string[], drawColor: string, drawIcon?: IconDrawer): void => {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (drawIcon) drawIcon(ctx, CANVAS_W / 2, ICON_Y);

    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = STROKE;
    ctx.fillStyle = drawColor;

    const centerY = drawIcon ? TEXT_Y_WITH_ICON : TEXT_Y_NO_ICON;
    const startY = centerY - (LINE_GAP * (drawLines.length - 1)) / 2;
    for (let i = 0; i < drawLines.length; i++) {
      const text = drawLines[i] ?? '';
      const y = startY + i * LINE_GAP;
      ctx.strokeText(text, CANVAS_W / 2, y);
      ctx.fillText(text, CANVAS_W / 2, y);
    }
    texture.needsUpdate = true;
  };
  draw(lines, color, icon);

  return { sprite, material, texture, canvas, ctx, draw };
}
