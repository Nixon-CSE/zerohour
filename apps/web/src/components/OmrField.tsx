"use client";
/**
 * Background: an answer sheet's bubble grid in drop-out ink. Bubbles near the pointer fill in
 * as if pencilled, then fade back. Static when the viewer prefers reduced motion.
 */
import { useEffect, useRef } from "react";

export function OmrField({ ink = "rgba(240,115,156,", fill = "rgba(147,169,255,", gap = 34, className = "" }: { ink?: string; fill?: string; gap?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0, heat: Float32Array = new Float32Array(0), cols = 0, rows = 0;
    const p = { x: -1e4, y: -1e4 };
    const resize = () => {
      const r = c.getBoundingClientRect();
      const d = Math.min(2, window.devicePixelRatio || 1);
      w = r.width; h = r.height;
      c.width = w * d; c.height = h * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      cols = Math.ceil(w / gap) + 1; rows = Math.ceil(h / gap) + 1;
      heat = new Float32Array(cols * rows);
      draw();
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = i * gap + gap / 2, y = j * gap + gap / 2, k = j * cols + i;
        const d = Math.hypot(x - p.x, y - p.y);
        if (!still) heat[k] = Math.max(heat[k] * 0.94, d < 120 ? 1 - d / 120 : 0);
        const v = heat[k];
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.strokeStyle = `${ink}${0.14 + v * 0.5})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        if (v > 0.02) { ctx.fillStyle = `${fill}${v * 0.85})`; ctx.fill(); }
      }
    };
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    const move = (e: PointerEvent) => { const r = c.getBoundingClientRect(); p.x = e.clientX - r.left; p.y = e.clientY - r.top; };
    const leave = () => { p.x = p.y = -1e4; };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();
    if (!still) {
      c.parentElement?.addEventListener("pointermove", move);
      c.parentElement?.addEventListener("pointerleave", leave);
      raf = requestAnimationFrame(loop);
    }
    return () => { cancelAnimationFrame(raf); ro.disconnect(); c.parentElement?.removeEventListener("pointermove", move); c.parentElement?.removeEventListener("pointerleave", leave); };
  }, [ink, fill, gap]);
  return <canvas ref={ref} aria-hidden className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}
