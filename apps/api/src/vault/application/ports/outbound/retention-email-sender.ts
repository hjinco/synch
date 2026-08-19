export type RetentionEmail = {
	to: string;
	subject: string;
	text: string;
	html: string;
};

export interface RetentionEmailSender {
	send(message: RetentionEmail): Promise<void>;
}
