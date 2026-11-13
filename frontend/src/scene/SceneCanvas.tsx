import { useEffect, useRef } from "react";
import { drawScene, FRAME_H, FRAME_W, type SceneFrame, type SceneTheme } from "./drawScene";

function readTheme(): SceneTheme {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  return {
    bg: token("--bg", "#FFFFFF"),
    fill: token("--fill", "#F4F4F4"),
    line: token("--line", "#DADADA"),
    mid: token("--mid", "#6B6B6B"),
    ink: token("--ink", "#111111"),
    fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif",
  };
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
    if (!ctx) return;
    drawScene(ctx, current, canvas.width / FRAME_W, readTheme());
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
    // The caption on the sign uses the page's typeface: repaint once it has loaded.
    void document.fonts?.ready.then(paint);
    return () => observer.disconnect();
  }, []);

  useEffect(paint, [frame]);

  return <canvas ref={ref} className={className} role="img" aria-label={label} width={FRAME_W} height={FRAME_H} />;
}
