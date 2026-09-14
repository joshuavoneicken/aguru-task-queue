import { useEffect, useRef } from 'react';

function hexA(hex: string, a: number): string {
  const m = hex.replace('#', '').trim();
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Session in-flight trend, ported from the mockup's drawSpark. The caller owns
 * the sample buffer; fewer than two points renders blank rather than a dot.
 */
export function Sparkline({ values }: { values: readonly number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = 62;
    const h = 20;
    const pad = 2.5;
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return; // jsdom has no 2d context
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2) return;

    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const n = values.length;
    const px = (i: number) => pad + (i / (n - 1)) * (w - pad * 2);
    const py = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
    const amber =
      getComputedStyle(document.documentElement).getPropertyValue('--inflight').trim() || '#e0a24a';

    ctx.beginPath();
    ctx.moveTo(px(0), py(values[0]!));
    for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(values[i]!));
    ctx.lineTo(px(n - 1), h - pad);
    ctx.lineTo(px(0), h - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexA(amber, 0.24));
    grad.addColorStop(1, hexA(amber, 0));
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(px(0), py(values[0]!));
    for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(values[i]!));
    ctx.strokeStyle = hexA(amber, 0.85);
    ctx.lineWidth = 1.3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px(n - 1), py(values[n - 1]!), 1.8, 0, Math.PI * 2);
    ctx.fillStyle = amber;
    ctx.fill();
  }, [values]);

  return <canvas ref={ref} className="spark" width={62} height={20} aria-hidden="true" />;
}
