import Link from "next/link"

export function Wordmark() {
  return (
    <Link href="/" className="font-semibold text-lg tracking-tight">
      looped <span className="text-primary">standups</span>
    </Link>
  )
}
