import { useEffect, useRef, type ReactNode } from "react";
import { useBackLayer } from "./back-stack";

/**
 * A bottom sheet. `modal` sheets dim what is behind and trap the user's attention (Revise, Filter, picker);
 * a non-modal sheet is a peek that leaves the page behind it usable (the map). Back closes it before anything else.
 */
export function MobileSheet({ label, onClose, modal = true, aboveTabs = false, children }: { label: string; onClose: () => void; modal?: boolean; aboveTabs?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useBackLayer(true, onClose);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (modal) ref.current?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, [modal]);

  return (
    <>
      {modal && <div className="m-scrim" onClick={onClose} aria-hidden="true" />}
      <div
        ref={ref}
        className={aboveTabs ? "m-sheet over-tabs" : "m-sheet"}
        role="dialog"
        aria-modal={modal}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <button type="button" className="m-grab" aria-label={`Close ${label}`} onClick={onClose} />
        {children}
      </div>
    </>
  );
}
