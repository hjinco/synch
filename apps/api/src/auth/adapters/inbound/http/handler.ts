import type { BetterAuth } from "../../outbound/better-auth";

export type AuthHttpHandler = {
	handle(request: Request): Promise<Response>;
};

export class BetterAuthHttpHandler implements AuthHttpHandler {
	constructor(private readonly auth: BetterAuth) {}

	async handle(request: Request): Promise<Response> {
		return await this.auth.handler(request);
	}
}
