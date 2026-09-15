// Builds a RequestContext for services from a real signed-in supabase-js client (anon key + user JWT),
// so service calls in tests go through RLS exactly like server actions do.
import { PROFILE_COLUMNS, type RequestContext } from '@/server/context';
import { signInAs, type SignedInUser } from './clients';
import type { FixtureUser } from './fixtures';

export async function contextFor(session: SignedInUser): Promise<RequestContext> {
  const { data, error } = await session.client.from('profiles').select(PROFILE_COLUMNS).eq('id', session.userId).single();
  if (error || !data) throw new Error(`profile for ${session.userId} not readable: ${error?.message ?? 'no row'}`);
  return { supabase: session.client, userId: session.userId, profile: data };
}

export async function contextForUser(user: FixtureUser): Promise<RequestContext> {
  return contextFor(await signInAs(user.email, user.password));
}
