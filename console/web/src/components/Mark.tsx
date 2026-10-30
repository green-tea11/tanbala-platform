// Знак Tanbala: бирка RFID — то, что компания вешает на вещи. Контур бирки, отверстие под шнурок и виток антенны.

export function Mark({ size = 24 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H8L3.5 12Z" fill="#1b6c80" />
      <circle cx="8.6" cy="12" r="1.6" fill="#f9fbfc" />
      <path d="M12.5 8.5h4.5v7h-4.5M14 10.5h1.5v3H14" stroke="#f9fbfc" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
