import type { ShouldRevalidateFunctionArgs } from 'react-router';

// ChatKit loads and authorizes its own threads. Updating its URL must not reload
// unrelated workspace data, but explicit refreshes and actions still revalidate.
export function shouldRevalidateChatNavigation(args: ShouldRevalidateFunctionArgs) {
  const { currentUrl, nextUrl, defaultShouldRevalidate } = args;
  if (args.formMethod || args.formAction || args.actionResult !== undefined || args.actionStatus !== undefined) return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname || !currentUrl.pathname.endsWith('/chat') || currentUrl.search === nextUrl.search) return defaultShouldRevalidate;
  const current = new URLSearchParams(currentUrl.search), next = new URLSearchParams(nextUrl.search);
  current.delete('thread'); next.delete('thread');
  return current.toString() === next.toString() ? false : defaultShouldRevalidate;
}
