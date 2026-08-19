export function defaultOrganizationSlug(userId: string): string {
	return `user-${userId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}
