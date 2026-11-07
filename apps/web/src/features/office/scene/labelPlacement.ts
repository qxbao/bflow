/**
 * Overlap bookkeeping for the labels over the canvas. Name tags only compete with other name tags; message boxes are placed afterwards
 * against every rectangle, so a box never hides a later agent's tag. The rectangle lists are reused between frames (no allocation per label).
 */
export class LabelPlacer {
  private readonly tagRects: number[] = [];
  private readonly allRects: number[] = [];
  private tagCount = 0;
  private allCount = 0;

  begin(): void { this.tagCount = 0; this.allCount = 0; }

  private static hits(rects: number[], count: number, x0: number, x1: number, y0: number, y1: number): boolean {
    for (let i = 0; i < count; i += 4) if (x0 < (rects[i + 1] as number) && x1 > (rects[i] as number) && y0 < (rects[i + 3] as number) && y1 > (rects[i + 2] as number)) return true;
    return false;
  }
  private static add(rects: number[], count: number, x0: number, x1: number, y0: number, y1: number): number {
    rects[count] = x0; rects[count + 1] = x1; rects[count + 2] = y0; rects[count + 3] = y1;
    return count + 4;
  }

  /** A name tag centred on `x` with its bottom at `y`. Far out, one overlapping an earlier tag is hidden (false); closer in everything shows. */
  tag(x: number, y: number, width: number, height: number, far: boolean): boolean {
    const x0 = x - width / 2, x1 = x + width / 2, y0 = y - height;
    if (far && LabelPlacer.hits(this.tagRects, this.tagCount, x0, x1, y0, y)) return false;
    this.tagCount = LabelPlacer.add(this.tagRects, this.tagCount, x0, x1, y0, y);
    this.allCount = LabelPlacer.add(this.allRects, this.allCount, x0, x1, y0, y);
    return true;
  }

  /** A message box centred on `x` with its bottom at `y`; call after every tag. One overlapping any tag or earlier box is hidden. */
  bubble(x: number, y: number, width: number, height: number, _far = true): boolean {
    const x0 = x - width / 2, x1 = x + width / 2, y0 = y - height;
    if (LabelPlacer.hits(this.allRects, this.allCount, x0, x1, y0, y)) return false;
    this.allCount = LabelPlacer.add(this.allRects, this.allCount, x0, x1, y0, y);
    return true;
  }
}
