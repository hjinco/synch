export interface InvitationEmailSender {
	send(email: string, invitationUrl: string): Promise<void>;
}
