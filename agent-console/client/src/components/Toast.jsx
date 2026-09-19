import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon.jsx";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Transient confirmation for actions that change something.
 *
 * Until now a delete simply made a row disappear and a save navigated away, which
 * leaves the operator guessing whether the thing they asked for actually happened —
 * and gives a failure nowhere to be reported except the console. A toast is the
 * smallest honest answer: what happened, to what, and whether it worked.
 *
 * Errors do not auto-dismiss. A message that vanishes before it is read is worse
 * than no message, because the user knows something went wrong and cannot find out
 * what.
 */

const ToastContext = createContext({ toast: () => {} });

/**
 * A solid bar on the leading edge carries the tone. The body stays neutral so a
 * stack of toasts does not turn into a stack of coloured blocks.
 */
const TONE = {
  success: { icon: "checkCircle", bar: "bg-success", text: "text-success" },
  danger: { icon: "xCircle", bar: "bg-danger", text: "text-danger" },
  warning: { icon: "alert", bar: "bg-warning", text: "text-warning" },
  info: { icon: "info", bar: "bg-primary", text: "text-primary" },
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    ({ title, description, tone = "success", duration }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setItems((current) => [
        ...current.slice(-3),
        { id, title, description, tone },
      ]);
      // Errors persist until dismissed; everything else clears itself.
      const life = duration ?? (tone === "danger" ? null : 4200);
      if (life) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), life),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
 aria-live on a container that is always mounted, so screen readers announce
 arrivals. `polite` because none of these interrupt a task.
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((item) => {
          const tone = TONE[item.tone] ?? TONE.info;
          return (
            <div
              key={item.id}
              role={item.tone === "danger" ? "alert" : "status"}
              className="pointer-events-auto flex animate-toast-in items-stretch border border-divider bg-content1 shadow-overlay"
            >
              <span
                aria-hidden="true"
                className={cn("w-[3px] shrink-0", tone.bar)}
              />
              <span className={cn("ml-3 mt-3 shrink-0", tone.text)}>
                <Icon name={tone.icon} className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 px-3 py-2.5">
                <strong className="block text-small font-semibold text-foreground">
                  {item.title}
                </strong>
                {item.description && (
                  <p className="wrap-anywhere mt-1 text-tiny leading-5 text-default-500">
                    {item.description}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                aria-label="Dismiss"
                onClick={() => dismiss(item.id)}
                className="h-auto w-9 shrink-0 self-stretch px-0 text-default-400 hover:bg-default-100 hover:text-foreground"
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
