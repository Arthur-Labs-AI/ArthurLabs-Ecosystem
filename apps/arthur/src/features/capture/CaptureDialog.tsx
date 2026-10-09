import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { useNavigation } from "../../app/navigation";
import { Icon } from "../../components/icons";
import { CaptureComposer } from "./CaptureComposer";
import { useCaptures } from "./captures-context";

const FOCUSABLE = 'button:not([disabled]), textarea, input, select, [href], [tabindex]:not([tabindex="-1"])';

/** Capture from anywhere (Ctrl/⌘ N). Closes itself once a capture has been saved, typed or spoken. */
export function CaptureDialog() {
  const { captureOpen, closeCapture } = useNavigation();
  const { voiceState, subscribe } = useCaptures();
  const dialog = useRef<HTMLDivElement>(null);
  const busy = voiceState !== "idle";

  useEffect(() => {
    if (!captureOpen) return;
    return subscribe(() => closeCapture());
  }, [captureOpen, subscribe, closeCapture]);

  // A layout effect, so the opener is recorded BEFORE the composer's own autofocus effect moves focus into the dialog.
  useLayoutEffect(() => {
    if (!captureOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previous?.focus();
  }, [captureOpen]);

  if (!captureOpen) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.stopPropagation();
      closeCapture();
    }
    if (event.key === "Tab" && dialog.current) {
      const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && closeCapture()}>
      <div ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-label="Capture a thought" onKeyDown={handleKeyDown}>
        <div className="dialog-head">
          <h2>New capture</h2>
          <button type="button" className="btn icon ghost" aria-label="Close" onClick={closeCapture} disabled={busy}>
            <Icon name="x" />
          </button>
        </div>
        <CaptureComposer compact autoFocus />
      </div>
    </div>
  );
}
