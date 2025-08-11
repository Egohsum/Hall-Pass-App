// src/hooks/usePersistentState.js
import { useEffect, useRef, useState } from "react";

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("Failed to write to localStorage:", e);
  }
}

export default function usePersistentState(key, initialValue) {
  const [state, setState] = useState(() => readStorage(key, initialValue));
  const lastKey = useRef(key);

  useEffect(() => {
    writeStorage(key, state);
  }, [key, state]);

  useEffect(() => {
    if (lastKey.current !== key) {
      const next = readStorage(key, initialValue);
      setState(next);
      lastKey.current = key;
    }
  }, [key, initialValue]);

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === key) {
        setState(readStorage(key, initialValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, initialValue]);

  return [state, setState];
}
