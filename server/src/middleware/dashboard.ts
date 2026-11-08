import type { FastifyRequest } from "fastify";
import { ApiError } from "../lib/api-error.ts";
import type { Profile, Role } from "../lib/repository.ts";

export type DashboardIdentity = {
  id: string;
  email: string;
};

export async function requireProfile(
  request: FastifyRequest,
  getDashboardUser: (token: string) => Promise<DashboardIdentity | null>,
  getProfile: (userId: string) => Promise<Profile | null>
): Promise<Profile> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHORIZED");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token || token.length > 8192) throw new ApiError(401, "UNAUTHORIZED");
  let user: DashboardIdentity | null;
  try {
    user = await getDashboardUser(token);
  } catch {
    throw new ApiError(503, "CHECK_UNAVAILABLE");
  }
  if (!user) throw new ApiError(401, "UNAUTHORIZED");
  const profile = await getProfile(user.id);
  if (!profile) throw new ApiError(401, "UNAUTHORIZED");
  return profile;
}

export function requireRole(profile: Profile, roles: readonly Role[]): void {
  if (!roles.includes(profile.role)) throw new ApiError(403, "FORBIDDEN");
}
