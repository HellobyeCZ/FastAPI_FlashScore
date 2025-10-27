"use client";

interface LiveRegionProps {
  message: string;
}

export function LiveRegion({ message }: LiveRegionProps) {
  if (!message) {
    return null;
  }

  return (
    <div aria-live="polite" aria-atomic="true" className="visually-hidden">
      {message}
    </div>
  );
}
