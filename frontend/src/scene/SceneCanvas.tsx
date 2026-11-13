import { useEffect, useRef } from "react";
import { drawScene, FRAME_H, FRAME_W, type SceneFrame, type SceneTheme } from "./drawScene";

/** The scene's colours (styles.css --scene-*, plus four page tokens), or null while the stylesheet has not defined
 * them (nothing is painted then). */
function readTheme(): SceneTheme | null {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => root.getPropertyValue(name).trim();
  const colours = {
    bg: token("--bg"),
    ink: token("--ink"),
    mid: token("--mid"),
    accent: token("--accent"),
    wall: token("--scene-wall"),
    wallSide: token("--scene-wall-side"),
    ceiling: token("--scene-ceiling"),
    floor: token("--scene-floor"),
    floorLine: token("--scene-floor-line"),
    rail: token("--scene-rail"),
    door: token("--scene-door"),
    doorEdge: token("--scene-door-edge"),
    picture: token("--scene-picture"),
    cloth1: token("--scene-cloth-1"),
    cloth2: token("--scene-cloth-2"),
    cloth3: token("--scene-cloth-3"),
    skin: token("--scene-skin"),
    trolley: token("--scene-trolley"),
    trolleyEdge: token("--scene-trolley-edge"),
    outline: token("--scene-outline"),
    tracking: token("--scene-tracking"),
    obstacle: token("--scene-obstacle"),
  };
  if (Object.values(colours).some((c) => !c)) return null;
  return { ...colours, fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif" };
}

interface Props {
  /** The frame to show; null leaves the last picture in place. */
  frame: SceneFrame | null;
  /** What the picture is, for people who cannot see it. */
  label: string;
  className?: string;
}

/** The simulator's camera view, drawn on a canvas that keeps the camera's 16:9 shape. */
export function SceneCanvas({ frame, label, className }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<SceneFrame | null>(frame);
  frameRef.current = frame;

  const paint = () => {
    const canvas = ref.current;
    const current = frameRef.current;
    if (!canvas || !current) return;
    const ctx = canvas.getContext("2d");
    const theme = readTheme();
    if (!ctx || !theme) return;
    // Frame pixels per CSS pixel: the flight logic's boxes and labels keep their size on screen.
    const uiScale = canvas.clientWidth > 0 ? FRAME_W / canvas.clientWidth : undefined;
    drawScene(ctx, current, canvas.width / FRAME_W, theme, uiScale);
  };

  // Keep the backing store at the displayed size times the device pixel ratio, so lines stay sharp.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(320, Math.round(canvas.clientWidth * dpr));
      if (canvas.width !== width) {
        canvas.width = width;
        canvas.height = Math.round((width * FRAME_H) / FRAME_W);
      }
      paint();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    // The caption on the sign and the labels use the page's typeface: repaint once it has loaded.
    void document.fonts?.ready.then(paint);
    return () => observer.disconnect();
  }, []);

  useEffect(paint, [frame]);

  return <canvas ref={ref} className={className} role="img" aria-label={label} width={FRAME_W} height={FRAME_H} />;
}
