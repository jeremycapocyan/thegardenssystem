"use client";
import { useCallback, useEffect, useState } from "react";
import { getBackend, friendlyError } from "@/lib/backend";
import { canManage } from "@/lib/access";
import {
  demoRoi,
  emptyRoi,
  type RoiData,
  type Capital,
  type CapitalExclusion,
} from "@/lib/roi";
import { useWorkspace } from "./workspace-provider";
const store = "gardens.roi.sample.v1";
export function useRoi() {
  const ws = useWorkspace(),
    [data, setData] = useState<RoiData>(emptyRoi),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      if (ws.mode === "demo") {
        let initial = demoRoi();
        try {
          const saved = JSON.parse(localStorage.getItem(store) || "null");
          if (
            saved &&
            Array.isArray(saved.capital) &&
            Array.isArray(saved.exclusions)
          )
            initial = saved;
        } catch {}
        setData(initial);
      } else if (ws.mode === "live") {
        const result = await getBackend()!.rpc("garden_roi_snapshot");
        if (result.error) throw Error(friendlyError(result.error));
        setData(result.data);
      } else setData(emptyRoi());
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load capital records.",
      );
    } finally {
      setLoading(false);
    }
  }, [ws.mode]);
  useEffect(() => {
    void refresh();
  }, [refresh, ws.syncedAt]);
  useEffect(() => {
    const reset = () => {
      localStorage.removeItem(store);
      setData(demoRoi());
    };
    window.addEventListener("gardens-demo-reset", reset);
    return () => window.removeEventListener("gardens-demo-reset", reset);
  }, []);
  async function save(
    kind: "capital" | "exclusions",
    row: Capital | CapitalExclusion,
  ) {
    if (!canManage(ws.profile, "finance"))
      throw Error("Finance management permission is required.");
    if (ws.mode === "demo") {
      const rows = data[kind] as (Capital | CapitalExclusion)[];
      const next = {
        ...data,
        [kind]: rows.some((r) => r.id === row.id)
          ? rows.map((r) => (r.id === row.id ? row : r))
          : [...rows, row],
      };
      localStorage.setItem(store, JSON.stringify(next));
      setData(next);
      return;
    }
    if (!navigator.onLine) throw Error("Reconnect before saving.");
    const result = await getBackend()!
      .from(kind === "capital" ? "garden_capital" : "garden_roi_exclusions")
      .upsert({ ...row } as Record<string, unknown>);
    if (result.error)
      throw Error(
        kind === "exclusions" && result.error.code === "23505"
          ? "This expense is already marked as a capital purchase."
          : friendlyError(result.error),
      );
    await refresh();
    await ws.refresh();
  }
  async function remove(kind: "capital" | "exclusions", id: string) {
    if (!canManage(ws.profile, "finance"))
      throw Error("Finance management permission is required.");
    if (ws.mode === "demo") {
      const next = { ...data, [kind]: data[kind].filter((r) => r.id !== id) };
      localStorage.setItem(store, JSON.stringify(next));
      setData(next);
      return;
    }
    if (!navigator.onLine) throw Error("Reconnect before saving.");
    const result = await getBackend()!
      .from(kind === "capital" ? "garden_capital" : "garden_roi_exclusions")
      .delete()
      .eq("id", id)
      .select("id")
      .single();
    if (result.error) throw Error(friendlyError(result.error));
    await refresh();
    await ws.refresh();
  }
  return { data, loading, error, refresh, save, remove };
}
