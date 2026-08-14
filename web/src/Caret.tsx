// Shared collapsible-group caret. `open` points down (expanded); closed points
// right. Sized via width/height so it stays crisp and obvious at any zoom.
export function Caret({ open, size = 16 }: { open: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}
