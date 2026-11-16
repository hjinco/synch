export function isOrganizationManager(role: string | null | undefined): boolean {
	return role === "owner" || role === "admin";
}
