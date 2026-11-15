import type { ShouldRevalidateFunctionArgs } from 'react-router';

const WORKSPACE_PATH = /^\/(?:chat|projects(?:\/prj_[a-f0-9]{32}(?:\/chat)?)?|connections(?:\/[^/]+)?|jobs|files|materials|settings)$/;
const PAGE_QUERIES = ['after', 'new', 'thread'];

// The mounted layout already owns member, connection and sidebar project data.
// Ordinary page navigation can reuse it; actions and explicit refreshes cannot.
export function shouldRevalidateWorkspaceNavigation(args: ShouldRevalidateFunctionArgs) {
  const { currentUrl, nextUrl, defaultShouldRevalidate } = args;
  if (args.formMethod || args.formAction || args.actionResult !== undefined || args.actionStatus !== undefined) return defaultShouldRevalidate;
  if (currentUrl.origin !== nextUrl.origin || !WORKSPACE_PATH.test(currentUrl.pathname) || !WORKSPACE_PATH.test(nextUrl.pathname)) return defaultShouldRevalidate;
  if (currentUrl.pathname === nextUrl.pathname && currentUrl.search === nextUrl.search) return defaultShouldRevalidate;
  const current = new URLSearchParams(currentUrl.search), next = new URLSearchParams(nextUrl.search);
  for (const key of PAGE_QUERIES) { current.delete(key); next.delete(key); }
  current.sort(); next.sort();
  // Authentication/connection return parameters and future unknown query state
  // keep normal revalidation rather than silently retaining stale identity.
  return current.toString() === next.toString() ? false : defaultShouldRevalidate;
}
