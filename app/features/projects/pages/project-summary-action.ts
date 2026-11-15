import type { ActionFunctionArgs } from 'react-router';
import { refreshProjectSummary } from '../server/projects.server';

export { routeHeaders as headers } from '~/common/server/backend.server';
export function action({ request, params }: ActionFunctionArgs) { return refreshProjectSummary(request, params.projectId); }
