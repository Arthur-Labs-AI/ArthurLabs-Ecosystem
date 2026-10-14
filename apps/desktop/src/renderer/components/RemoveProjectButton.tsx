import React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { sentryApi } from '../lib/sentry-api.js';

/** Deletion is committed by the runtime before any mounted query is refreshed. */
export function RemoveProjectButton({
  projectId,
  name,
  state,
  onRemoved,
}: {
  projectId: string;
  name: string;
  state: string;
  onRemoved?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = React.useState(false);
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const removal = useMutation({
    mutationFn: () => sentryApi().projects.remove(projectId),
    onSuccess: async () => {
      setConfirm(false);
      onRemoved?.();
      // Project deletion cascades into runs, issues, revisions and artifacts.
      // Refresh all mounted consumers from canonical state, including Dashboard.
      await queryClient.invalidateQueries();
    },
  });
  React.useEffect(() => {
    if (!confirm) return;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, [confirm]);
  const dismiss = (): void => {
    if (!removal.isPending) setConfirm(false);
  };
  return (
    <>
      <button
        className="compact danger"
        aria-label={'Remove project ' + name}
        disabled={state !== 'ready' || removal.isPending}
        title={
          state !== 'ready'
            ? 'Finish the active run or project operation before removing this project.'
            : 'Remove Sentry’s stored copy and history'
        }
        onClick={() => {
          removal.reset();
          setConfirm(true);
        }}
      >
        <Trash2 size={13} aria-hidden="true" /> Remove project
      </button>
      {confirm ? (
        <dialog
          ref={dialogRef}
          className="project-removal-dialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onCancel={(event) => {
            event.preventDefault();
            dismiss();
          }}
        >
          <h2 id={titleId}>Remove {name}?</h2>
          <p id={descriptionId}>
            This permanently deletes Sentry’s stored copy, revisions, run history, findings and
            evidence for this project to free disk space. Your original source folder is kept. This
            cannot be undone.
          </p>
          {removal.error ? (
            <p className="error-box" role="alert">
              {removal.error instanceof Error ? removal.error.message : String(removal.error)}
            </p>
          ) : null}
          <div className="actions">
            <button autoFocus disabled={removal.isPending} onClick={dismiss}>
              Cancel
            </button>
            <button
              className="danger"
              disabled={removal.isPending || state !== 'ready'}
              onClick={() => removal.mutate()}
            >
              {removal.isPending ? 'Removing…' : 'Remove permanently'}
            </button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
