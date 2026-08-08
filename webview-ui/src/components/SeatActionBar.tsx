import { useEffect, useState } from 'react';

import type { RosterSeatInfo } from '../hooks/useExtensionMessages.js';
import { Button } from './ui/Button.js';

interface SeatActionBarProps {
  seat: RosterSeatInfo;
  /** Give the employee a job. */
  onStartWork: (task: string) => void;
  /** Mark what the employee is waiting on as answered. */
  onResolveStuck: () => void;
  onDismiss: () => void;
}

/**
 * Actions for a selected roster employee.
 *
 * Only shown for employees, never for walk-in sessions: an orchestrator can act
 * on its own staff, but nothing can reach into a terminal somebody started by
 * hand, and a button that silently does nothing is worse than no button.
 *
 * Starting work is behind a text field rather than a single click, because a
 * stray click on a character should never dispatch a real job.
 */
export function SeatActionBar({
  seat,
  onStartWork,
  onResolveStuck,
  onDismiss,
}: SeatActionBarProps) {
  const [task, setTask] = useState('');
  const [composing, setComposing] = useState(false);

  // Selecting a different employee resets the draft, so a job typed for one
  // person can never be dispatched to another.
  useEffect(() => {
    setTask('');
    setComposing(false);
  }, [seat.seatId]);

  const submit = () => {
    const trimmed = task.trim();
    if (!trimmed) return;
    onStartWork(trimmed);
    setTask('');
    setComposing(false);
  };

  return (
    <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-10 flex gap-4 items-center pixel-panel p-4">
      <span className="text-text">{seat.title}</span>

      {seat.state === 'stuck' && (
        <Button
          size="md"
          onClick={onResolveStuck}
          title="Mark what this employee is waiting on as answered"
        >
          Mark resolved
        </Button>
      )}

      {composing ? (
        <>
          <input
            // autoFocus, not a focus effect: the effect runs a tick after the
            // input mounts, and a keystroke landing in that gap is dropped.
            autoFocus
            className="min-w-0 bg-bg text-text border-2 border-border px-2 py-0.5"
            value={task}
            placeholder="What should they do?"
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') setComposing(false);
            }}
          />
          <Button
            variant={task.trim() ? 'default' : 'disabled'}
            size="md"
            onClick={task.trim() ? submit : undefined}
          >
            Send
          </Button>
        </>
      ) : (
        <Button size="md" onClick={() => setComposing(true)} title="Give this employee a job">
          Give work
        </Button>
      )}

      <Button size="md" onClick={onDismiss} title="Close">
        Close
      </Button>
    </div>
  );
}
