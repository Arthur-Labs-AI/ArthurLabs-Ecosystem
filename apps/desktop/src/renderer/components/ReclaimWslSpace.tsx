import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sentryApi } from '../lib/sentry-api.js';
import { PageSection } from './ui/PageHeader.js';

function gib(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(2) + ' GiB';
}

export function ReclaimWslSpace({
  distro,
  connected,
}: {
  distro: string | undefined;
  connected: boolean;
}): React.JSX.Element {
  const client = useQueryClient();
  const [confirm, setConfirm] = React.useState(false);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const activeRuns = useQuery({
    queryKey: ['system', 'active-runs'],
    queryFn: () => sentryApi().system.activeRuns(),
    refetchInterval: 5000,
    retry: false,
  });
  const operation = useMutation({
    mutationFn: () => sentryApi().runtime.reclaimSpace(),
    onSuccess: () => {
      setConfirm(false);
    },
    onSettled: async () => {
      await client.invalidateQueries();
    },
  });
  React.useEffect(() => {
    if (!confirm) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [confirm]);
  const blocked =
    !connected ||
    !distro ||
    !Array.isArray(activeRuns.data) ||
    activeRuns.isError ||
    activeRuns.data.length > 0;
  const dismiss = (): void => {
    if (!operation.isPending) setConfirm(false);
  };
  return (
    <PageSection title="Windows disk space">
      <div className="card">
        <p>
          Removing projects frees storage inside WSL. Reclaim unused blocks to return that space to
          Windows.
        </p>
        <p className="metadata">
          The virtual disk can grow again when needed. Compaction does not delete projects or set a
          fixed free-space reserve.
        </p>
        <button
          className="primary"
          disabled={blocked || operation.isPending}
          onClick={() => {
            operation.reset();
            setConfirm(true);
          }}
        >
          Reclaim Windows disk space
        </button>
        {blocked ? (
          <p className="metadata">
            Connect the runtime and finish active QA before reclaiming space.
          </p>
        ) : null}
        {operation.data ? (
          <p role="status">
            Reclaimed{' '}
            {gib(Math.max(0, operation.data.diskBytesBefore - operation.data.diskBytesAfter))} from
            the {operation.data.distro} disk. Windows drive free:{' '}
            {gib(operation.data.windowsFreeBytesAfter)}.
            {operation.data.reconnected ? ' Sentry reconnected.' : ''}
          </p>
        ) : null}
        {operation.data?.reconnected === false ? (
          <p className="error-box" role="alert">
            Compaction finished. Reconnect failed; restart Sentry and check Environment.
          </p>
        ) : null}
        {confirm ? (
          <dialog
            ref={dialog}
            className="project-removal-dialog"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onCancel={(event) => {
              event.preventDefault();
              dismiss();
            }}
          >
            <h2 id={titleId}>Reclaim Windows disk space?</h2>
            <p id={descriptionId}>
              Sentry will stop its runtime and shut down WSL to compact the {distro} disk. Save work
              and close other applications using WSL, including Docker and terminals. If another
              distribution is running, Sentry will refuse. Windows will request administrator
              approval. Keep Sentry open until compaction finishes. Your files are kept, and the
              disk can grow again as needed. The amount reclaimed may be zero.
            </p>
            {operation.error ? (
              <p role="alert" className="error-box">
                {operation.error instanceof Error
                  ? operation.error.message
                  : String(operation.error)}
              </p>
            ) : null}
            {operation.isPending ? (
              <p role="status">
                Stopping the runtime, reclaiming disk space, then reconnecting. This may take
                several minutes.
              </p>
            ) : null}
            <div className="actions">
              <button autoFocus disabled={operation.isPending} onClick={dismiss}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={blocked || operation.isPending}
                onClick={() => operation.mutate()}
              >
                {operation.isPending ? 'Reclaiming…' : 'Shut down WSL and reclaim'}
              </button>
            </div>
          </dialog>
        ) : null}
      </div>
    </PageSection>
  );
}
