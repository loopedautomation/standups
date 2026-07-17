import Link from "next/link"

/** The looped brandmark, from @looped/ui. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      width="64"
      height="102"
      viewBox="0 0 64 102"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Looped"
    >
      <title>Looped</title>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M32 0.368652C41.9277 0.368652 49.8699 8.31082 49.8699 18.2385V59.9349C49.8699 61.9867 51.1936 63.7075 53.1791 64.3031L57.8121 66.5534C61.1213 67.8771 63.7687 71.1864 63.7687 74.8265V84.4233C63.7687 94.0201 56.1574 101.631 46.5606 101.631H31.3382C21.7414 101.631 14.1301 94.0201 14.1301 84.4233V42.0651C14.1301 40.0795 12.8064 38.4249 11.1518 37.763L5.85702 34.7847C2.54778 33.461 0.231312 30.4827 0.231312 27.1735V18.2385C0.231312 8.64175 8.17348 0.368652 17.7703 0.368652H32ZM18.763 15.5911C16.1157 15.5911 14.1301 17.5767 14.1301 20.2241V37.4321C14.1301 39.0867 15.1229 40.4104 16.4466 41.2708L19.4249 43.3888L26.7052 48.3526C27.698 49.3454 28.6908 50.6691 28.6908 52.6546V83.0996C28.6908 85.747 30.6763 87.7326 33.3237 87.7326H45.237C47.8843 87.7326 49.8699 85.747 49.8699 83.0996V65.2297C49.8699 63.2442 48.8771 61.5896 47.2225 60.5968L37.2948 53.9783C36.302 52.9855 35.6402 51.3309 35.6402 49.6763V20.2241C35.6402 17.5767 33.6546 15.5911 31.0072 15.5911H18.763Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2">
      <BrandMark className="h-5 w-auto" />
      <span className="font-semibold text-base-content text-lg tracking-tight">
        meet
      </span>
    </Link>
  )
}
