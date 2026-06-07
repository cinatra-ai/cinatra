"use client";
import { useCallback, useRef, useState } from "react";

export type EditHistoryHandle<Op> = {
  push: (op: Op) => void;
  undo: () => void;
  redo: () => void;
  clearAll: () => void;
  canUndo: boolean;
  canRedo: boolean;
  pendingOps: Op[];
};

export function useEditHistory<Op>(): EditHistoryHandle<Op> {
  const [past, setPast] = useState<Op[]>([]);
  const [future, setFuture] = useState<Op[]>([]);
  const pastRef = useRef<Op[]>([]);
  pastRef.current = past;

  const push = useCallback((op: Op) => {
    setPast((p) => [...p, op]);
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const undone = p[p.length - 1];
      setFuture((f) => [undone, ...f]);
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const [redone, ...rest] = f;
      setPast((p) => [...p, redone]);
      return rest;
    });
  }, []);

  const clearAll = useCallback(() => {
    setPast([]);
    setFuture([]);
  }, []);

  return {
    push,
    undo,
    redo,
    clearAll,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    pendingOps: past,
  };
}
