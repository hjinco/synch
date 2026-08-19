export type AuthenticatedUser = {
	id: string;
	email: string;
};

export type AuthenticatedSession = {
	user: AuthenticatedUser;
	session: {
		activeOrganizationId: string | null;
	};
};

export type SessionLookup = {
	url: URL;
	authorization?: string;
	cookie?: string;
};
