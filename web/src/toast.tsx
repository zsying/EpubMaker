import { useEffect, useState } from 'react';

type ToastType = 'info' | 'success' | 'error';
interface Item {
  id: number;
  msg: string;
  type: ToastType;
}

let seq = 0;
const listeners = new Set<(items: Item[]) => void>();
let items: Item[] = [];

function emit() {
  listeners.forEach((l) => l([...items]));
}

export function toast(msg: string, type: ToastType = 'info', ms = 3200) {
  const id = ++seq;
  items = [...items, { id, msg, type }];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== id);
    emit();
  }, ms);
}

export const toastError = (e: unknown) =>
  toast(e instanceof Error ? e.message : String(e), 'error', 5000);

export function Toaster() {
  const [list, setList] = useState<Item[]>([]);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toasts">
      {list.map((i) => (
        <div key={i.id} className={`toast ${i.type}`}>
          {i.msg}
        </div>
      ))}
    </div>
  );
}
