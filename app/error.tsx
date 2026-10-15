'use client';

export default function RoomError({ reset }: { reset: () => void }) {
  return <main className="gate">
    <p role="alert">Could not load the draft room.</p>
    <button onClick={reset}>Retry</button>
  </main>;
}
