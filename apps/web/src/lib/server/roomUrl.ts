/**
 * The shareable join link for a room. Uses the short-link base when configured
 * (e.g. https://lpd.sh/meet, redirected at the edge to /r/{slug}), otherwise
 * this deployment's own /r/{slug}, resolved against the incoming request.
 */
export function roomShareUrl(slug: string, requestUrl: string): string {
  const base = process.env.SHARE_LINK_BASE?.replace(/\/$/, "")
  return base ? `${base}/${slug}` : new URL(`/r/${slug}`, requestUrl).toString()
}
