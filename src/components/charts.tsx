"use client";
import { useEffect, useRef, useState } from "react";
import { money, type trend } from "@/lib/finance";

export function CashFlowChart({
  points,
}: {
  points: ReturnType<typeof trend>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () =>
      setWidth(Math.max(280, Math.round(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = 275,
    left = 64,
    right = 18,
    top = 20,
    bottom = 42;
  const max = Math.max(
    10000,
    ...points.flatMap((p) => [p.income, p.expense, p.net]),
  );
  const min = Math.min(0, ...points.map((p) => p.net));
  const y = (value: number) =>
    top + ((max - value) / (max - min)) * (height - top - bottom);
  const step = (width - left - right) / points.length;
  const labelStride = Math.ceil(56 / step);
  const zero = y(0);
  const barWidth = Math.min(17, step * 0.27);
  const hasData = points.some((p) => p.income || p.expense);
  const line = points
    .map((p, i) => `${left + step * (i + 0.5)},${y(p.net)}`)
    .join(" ");
  return (
    <div className="cash-chart" ref={container}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Income and expenses by period, with a net income trend line"
      >
        <title>Income, expenses and net income</title>
        {Array.from({ length: 5 }, (_, i) => {
          const amount = max - ((max - min) * i) / 4;
          return (
            <g key={i}>
              <line
                x1={left}
                x2={width - right}
                y1={y(amount)}
                y2={y(amount)}
                stroke="#E5EAE3"
                strokeDasharray="3 5"
              />
              <text
                x={left - 10}
                y={y(amount) + 4}
                textAnchor="end"
                className="chart-tick"
              >
                {new Intl.NumberFormat("en-PH", {
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(amount / 100)}
              </text>
            </g>
          );
        })}
        <text x={left} y={11} className="chart-tick">
          PHP
        </text>
        {points.map((p, i) => {
          const x = left + step * (i + 0.5);
          return (
            <g key={p.start}>
              <rect
                x={x - barWidth - 1}
                y={y(p.income)}
                width={barWidth}
                height={Math.max(0, zero - y(p.income))}
                rx={3}
                fill="#276346"
              >
                <title>
                  {p.label}: income {money(p.income)}
                </title>
              </rect>
              <rect
                x={x + 1}
                y={y(p.expense)}
                width={barWidth}
                height={Math.max(0, zero - y(p.expense))}
                rx={3}
                fill="#B6C9A0"
              >
                <title>
                  {p.label}: expenses {money(p.expense)}
                </title>
              </rect>
              {(i === points.length - 1 ||
                (i % labelStride === 0 &&
                  points.length - 1 - i >= labelStride * 0.65)) && (
                <text
                  x={x}
                  y={height - 14}
                  textAnchor="middle"
                  className="chart-tick"
                >
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
        {hasData && (
          <polyline
            points={line}
            fill="none"
            stroke="#C69B48"
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
        )}
        {!hasData && (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            className="chart-empty"
          >
            Your transactions will appear here
          </text>
        )}
      </svg>
    </div>
  );
}
export function ExpenseMix({
  entries,
}: {
  entries: { name: string; amount: number }[];
}) {
  const sorted = entries
    .filter((e) => e.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const visible = sorted.slice(0, 4);
  if (sorted.length > 4)
    visible.push({
      name: "Other categories",
      amount: sorted.slice(4).reduce((s, e) => s + e.amount, 0),
    });
  const total = visible.reduce((s, e) => s + e.amount, 0);
  const colors = ["#276346", "#A9C480", "#D2B86F", "#7D9D9A", "#DCE4D6"];
  let angle = 0;
  const segments = visible.map((entry, i) => {
    const start = angle;
    angle += (entry.amount / total) * 360;
    return `${colors[i]} ${start}deg ${angle}deg`;
  });
  return (
    <div className="expense-mix">
      <div
        className="donut"
        role="img"
        aria-label={
          total
            ? visible.map((e) => `${e.name}: ${money(e.amount)}`).join("; ")
            : "No expenses in the selected period"
        }
        style={{
          background: total
            ? `conic-gradient(${segments.join(",")})`
            : "#E8EDE5",
        }}
      >
        <div>
          <span>Total expenses</span>
          <strong>{money(total)}</strong>
        </div>
      </div>
      <div className="mix-legend">
        {visible.map((entry, i) => (
          <div key={entry.name}>
            <span>
              <i style={{ background: colors[i] }} />
              {entry.name}
            </span>
            <strong>{money(entry.amount)}</strong>
          </div>
        ))}
        {!total && (
          <p className="muted">Categories appear after your first payment.</p>
        )}
      </div>
    </div>
  );
}
