export type OutgoingEmail = {
	from: string;
	to: string;
	subject: string;
	text?: string;
	html?: string;
};

export interface EmailSender {
	send(message: OutgoingEmail): Promise<unknown>;
}
