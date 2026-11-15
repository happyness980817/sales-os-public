import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  index('features/chat/pages/index-page.tsx'),
  route('api/*', 'common/server/api-route.ts'),
  route('auth/callback', 'features/auth/pages/callback-page.tsx'),
  route('auth/sign-in', 'features/auth/pages/sign-in.ts'),
  route('auth/sign-out', 'features/auth/pages/sign-out.ts'),
  route('connections/manage', 'features/connections/pages/connection-action.ts'),
  route('projects/:projectId/summary', 'features/projects/pages/project-summary-action.ts'),
  layout('common/layouts/workspace-layout.tsx', [
    route('chat', 'features/chat/pages/chat-page.tsx'),
    route('projects', 'features/projects/pages/projects-page.tsx'),
    route('projects/:projectId', 'features/projects/pages/project-detail-page.tsx'),
    route('projects/:projectId/chat', 'features/chat/pages/project-chat-page.tsx'),
    route('connections', 'features/connections/pages/connections-page.tsx'),
    route('connections/:provider', 'features/connections/pages/connection-detail-page.tsx'),
    route('jobs', 'features/jobs/pages/jobs-page.tsx'),
    route('files', 'features/files/pages/files-page.tsx'),
    route('materials', 'features/materials/pages/materials-page.tsx'),
    route('settings', 'features/settings/pages/settings-page.tsx'),
  ]),
] satisfies RouteConfig;
